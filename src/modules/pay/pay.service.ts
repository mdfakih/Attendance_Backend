import { Injectable } from '@nestjs/common';
import type { PayableDaysBasis, PayAdjustmentInput, PayRegisterQuery } from '@attendance/contracts';
import { Decimal } from 'decimal.js';
import { AuditService } from '../../core/audit/audit.service.js';
import { employeeScopeWhere, isInScope } from '../../core/auth/scope.js';
import { currentContext, requireTenantId, requireTenantUser } from '../../core/context/request-context.js';
import { sha256Hex } from '../../core/crypto/crypto.util.js';
import { DbService } from '../../core/database/db.service.js';
import { AppError, notFound } from '../../core/http/app-error.js';
import { QUEUE, type RecomputePayJob } from '../../core/queue/queues.js';
import { QueueService } from '../../core/queue/queue.service.js';
import { dateOnly, iso, money, num } from '../../common/serialize.js';
import type { EmployeePaySummary, Prisma } from '../../generated/prisma/client.js';
import { classifyDay } from '../../engines/attendance/calendar.js';
import { computeEarnedPay, PAY_ENGINE_VERSION, type PayDay, type PayResult, type SalarySegmentInput } from '../../engines/pay/earned-pay.js';
import { localDateOf, minDate, monthRange, toDbDate } from '../../engines/time/dates.js';
import { DayInputsLoader } from '../attendance/day-inputs.loader.js';

const SUMMARY_FIELDS = (r: PayResult) => ({
  salaryBasis: r.salaryBasis,
  rate: r.rate === null ? null : new Decimal(r.rate),
  divisor: new Decimal(r.divisor),
  periodDays: r.periodDays,
  employedDays: new Decimal(r.employedDays),
  entitledDays: new Decimal(r.entitledDays),
  presentDays: new Decimal(r.presentDays),
  halfDays: new Decimal(r.halfDays),
  paidHolidayDays: new Decimal(r.paidHolidayDays),
  weeklyOffDays: new Decimal(r.weeklyOffDays),
  paidLeaveDays: new Decimal(r.paidLeaveDays),
  unpaidLeaveDays: new Decimal(r.unpaidLeaveDays),
  absentDays: new Decimal(r.absentDays),
  lopDays: new Decimal(r.lopDays),
  payableDays: new Decimal(r.payableDays),
  workedMinutes: r.workedMinutes,
  otApprovedMinutes: r.otApprovedMinutes,
  segments: r.segments as unknown as Prisma.InputJsonValue,
  baseEarned: new Decimal(r.baseEarned),
  otEarned: new Decimal(r.otEarned),
  additions: new Decimal(r.additions),
  deductions: new Decimal(r.deductions),
  netEarned: new Decimal(r.netEarned),
  mtdThrough: r.mtdThrough ? toDbDate(r.mtdThrough) : null,
  projectedNet: r.projectedNet === null ? null : new Decimal(r.projectedNet),
  flags: [...r.flags],
});

@Injectable()
export class PayService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly loader: DayInputsLoader,
    private readonly queues: QueueService,
  ) {}

  /** Recomputes one employee's month. Runs in the worker (tenant context set by the caller). */
  async recomputeEmployeeMonth(employeeId: string, month: string): Promise<EmployeePaySummary | null> {
    const tenantId = requireTenantId();
    const { start, end } = monthRange(month);
    const period = await this.db.tenant.payPeriod.upsert({
      where: { tenantId_month: { tenantId, month: toDbDate(start) } },
      update: {},
      create: { tenantId, month: toDbDate(start) },
    });
    if (period.status === 'LOCKED') return null;
    const [tenant, settings, employee, ctx, days, salary, adjustments, overtime] = await Promise.all([
      this.db.platform.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { timezone: true } }),
      this.db.tenant.tenantSettings.findUniqueOrThrow({ where: { tenantId } }),
      this.db.tenant.employee.findUnique({ where: { id: employeeId } }),
      this.loader.load(employeeId, start, end),
      this.db.tenant.attendanceDay.findMany({ where: { employeeId, attendanceDate: { gte: toDbDate(start), lte: toDbDate(end) } } }),
      this.db.tenant.employeeSalaryAssignment.findMany({
        where: { employeeId, effectiveFrom: { lte: toDbDate(end) }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: toDbDate(start) } }] },
        orderBy: { effectiveFrom: 'asc' },
      }),
      this.db.tenant.payAdjustment.findMany({ where: { employeeId, payPeriodId: period.id, voidedAt: null } }),
      this.db.tenant.tenantFeature.findUnique({ where: { tenantId_key: { tenantId, key: 'OVERTIME' } } }),
    ]);
    if (!employee || !ctx) return null;
    const calendar = new Map([...ctx.days.entries()].map(([date, d]) => [date, classifyDay(date, d.holiday, d.weeklyOffRules).dayType]));
    const payDays: PayDay[] = days.map((d) => ({
      date: dateOnly(d.attendanceDate) as string,
      dayType: d.dayType,
      finalStatus: d.finalStatus,
      paidFraction: Number(d.paidFraction),
      lopFraction: Number(d.lopFraction),
      leaveFraction: Number(d.leaveFraction),
      leavePaid: d.leavePaid,
      holidayPaid: d.holidayPaid,
      workedMinutes: d.workedMinutes,
      otApprovedMinutes: d.otApprovedMinutes,
      isFinalized: d.isFinalized,
    }));
    const segments: SalarySegmentInput[] = salary.map((s) => ({
      from: dateOnly(s.effectiveFrom) as string,
      to: dateOnly(s.effectiveTo),
      basis: s.salaryBasis,
      amount: s.amount.toFixed(2),
      otMultiplier: s.otMultiplier ? s.otMultiplier.toFixed(2) : null,
    }));
    const result = computeEarnedPay({
      periodStart: start,
      periodEnd: end,
      joinDate: dateOnly(employee.dateOfJoining) as string,
      exitDate: dateOnly(employee.exitDate),
      calendar,
      days: payDays,
      salary: segments,
      divisorMode: settings.payableDaysBasis as PayableDaysBasis,
      overtimeEnabled: overtime?.enabled ?? false,
      defaultOtMultiplier: settings.defaultOtMultiplier.toFixed(2),
      dutyMinutes: employee.dutyMinutes ?? ctx.days.get(start)?.shift?.dutyMinutes ?? 480,
      adjustments: adjustments.map((a) => ({ direction: a.direction as 'ADDITION' | 'DEDUCTION', amount: a.amount.toFixed(2) })),
      asOf: minDate(localDateOf(new Date(), tenant.timezone), end),
      roundNet: settings.netPayRounding === 'NEAREST_RUPEE',
    });
    const inputsHash = sha256Hex(JSON.stringify({ result, v: PAY_ENGINE_VERSION }));
    const existing = await this.db.tenant.employeePaySummary.findUnique({ where: { employeeId_periodStart: { employeeId, periodStart: toDbDate(start) } } });
    if (existing?.inputsHash === inputsHash) return existing;
    const data = { ...SUMMARY_FIELDS(result), divisorMode: settings.payableDaysBasis, inputsHash, engineVersion: PAY_ENGINE_VERSION, computedAt: new Date() };
    return this.db.tenant.employeePaySummary.upsert({
      where: { employeeId_periodStart: { employeeId, periodStart: toDbDate(start) } },
      update: data,
      create: { ...data, tenantId, employeeId, payPeriodId: period.id, periodStart: toDbDate(start), periodEnd: toDbDate(end) },
    });
  }

  async recomputeTenantMonth(month: string): Promise<number> {
    const { start, end } = monthRange(month);
    const employees = await this.db.tenant.employee.findMany({
      where: { dateOfJoining: { lte: toDbDate(end) }, OR: [{ status: { in: ['ACTIVE', 'INVITED'] } }, { exitDate: { gte: toDbDate(start) } }] },
      select: { id: true },
    });
    for (const e of employees) await this.recomputeEmployeeMonth(e.id, month);
    return employees.length;
  }

  async register(query: PayRegisterQuery) {
    const { start } = monthRange(query.month);
    const where: Prisma.EmployeeWhereInput = {
      ...employeeScopeWhere(),
      ...(query.branchId ? { branchId: query.branchId } : {}),
      ...(query.departmentId ? { departmentId: query.departmentId } : {}),
      ...(query.q ? { fullName: { contains: query.q, mode: 'insensitive' } } : {}),
    };
    const period = await this.db.tenant.payPeriod.findUnique({ where: { tenantId_month: { tenantId: requireTenantId(), month: toDbDate(start) } } });
    const summaries = await this.db.tenant.employeePaySummary.findMany({ where: { periodStart: toDbDate(start) } });
    const byEmployee = new Map(summaries.map((s) => [s.employeeId, s]));
    const [employees, total] = await Promise.all([
      this.db.tenant.employee.findMany({
        where: { ...where, id: { in: [...byEmployee.keys()] } },
        include: { branch: { select: { name: true } }, department: { select: { name: true } } },
        orderBy: { fullName: 'asc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.db.tenant.employee.count({ where: { ...where, id: { in: [...byEmployee.keys()] } } }),
    ]);
    const items = employees.map((e) => this.summaryDto(e, byEmployee.get(e.id) as EmployeePaySummary));
    const all = summaries.filter((s) => employees.some((e) => e.id === s.employeeId) || query.page === 1);
    const totals = {
      employees: summaries.length,
      netEarned: money(summaries.reduce((acc, s) => acc.plus(s.netEarned), new Decimal(0))),
      additions: money(summaries.reduce((acc, s) => acc.plus(s.additions), new Decimal(0))),
      deductions: money(summaries.reduce((acc, s) => acc.plus(s.deductions), new Decimal(0))),
      lopDays: num(all.reduce((acc, s) => acc.plus(s.lopDays), new Decimal(0))),
    };
    return { month: query.month, status: period?.status ?? 'OPEN', lockedAt: iso(period?.lockedAt), items, total, totals };
  }

  async employeeMonth(employeeId: string, month: string) {
    const employee = await this.db.tenant.employee.findUnique({ where: { id: employeeId }, include: { branch: { select: { name: true } }, department: { select: { name: true } } } });
    if (!employee || !isInScope(employee)) throw notFound('Employee');
    const summary = await this.ensureSummary(employeeId, month);
    const adjustments = summary ? await this.db.tenant.payAdjustment.findMany({ where: { employeeId, payPeriodId: summary.payPeriodId }, orderBy: { createdAt: 'desc' } }) : [];
    return {
      summary: summary ? this.summaryDto(employee, summary) : null,
      adjustments: adjustments.map((a) => ({ id: a.id, direction: a.direction, label: a.label, amount: money(a.amount), reason: a.reason, voided: !!a.voidedAt, createdAt: iso(a.createdAt) })),
    };
  }

  /** Employee-facing: month-to-date for the current month and locked months only for history. */
  async earnings(employeeId: string, month: string, current: boolean) {
    const summary = current ? await this.ensureSummary(employeeId, month) : await this.db.tenant.employeePaySummary.findUnique({ where: { employeeId_periodStart: { employeeId, periodStart: toDbDate(`${month}-01`) } } });
    if (!summary || (!current && summary.status !== 'LOCKED')) return null;
    return {
      month,
      status: summary.status,
      basis: summary.salaryBasis,
      payableDays: num(summary.payableDays),
      lopDays: num(summary.lopDays),
      workedMinutes: summary.workedMinutes,
      otMinutes: summary.otApprovedMinutes,
      baseEarned: money(summary.baseEarned),
      otEarned: money(summary.otEarned),
      additions: money(summary.additions),
      deductions: money(summary.deductions),
      netEarned: money(summary.netEarned),
      projectedNet: money(summary.projectedNet),
      mtdThrough: dateOnly(summary.mtdThrough),
    };
  }

  async addAdjustment(input: PayAdjustmentInput) {
    const employee = await this.db.tenant.employee.findUnique({ where: { id: input.employeeId } });
    if (!employee || !isInScope(employee)) throw notFound('Employee');
    const period = await this.openPeriod(input.month);
    const row = await this.db.tenant.payAdjustment.create({
      data: {
        tenantId: requireTenantId(),
        employeeId: input.employeeId,
        payPeriodId: period.id,
        direction: input.kind,
        label: input.label,
        amount: new Decimal(input.amount),
        reason: input.reason,
        createdById: requireTenantUser().membershipId,
      },
    });
    await this.audit.record({ action: 'pay.adjustment.create', entityType: 'employee', entityId: input.employeeId, after: row, reason: input.reason });
    await this.queueRecompute(input.employeeId, input.month);
    return { id: row.id };
  }

  async voidAdjustment(id: string, reason: string) {
    const row = await this.db.tenant.payAdjustment.findUnique({ where: { id }, include: { payPeriod: true } });
    if (!row || row.voidedAt) throw notFound('Adjustment');
    if (row.payPeriod.status === 'LOCKED') throw new AppError('PERIOD_LOCKED');
    await this.db.tenant.payAdjustment.update({ where: { id }, data: { voidedAt: new Date(), voidedById: requireTenantUser().membershipId, voidReason: reason } });
    await this.audit.record({ action: 'pay.adjustment.void', entityType: 'employee', entityId: row.employeeId, before: row, reason });
    await this.queueRecompute(row.employeeId, row.payPeriod.month.toISOString().slice(0, 7));
  }

  async lockCheck(month: string) {
    const { start, end } = monthRange(month);
    const tenant = await this.db.platform.tenant.findUniqueOrThrow({ where: { id: requireTenantId() }, select: { timezone: true } });
    const today = localDateOf(new Date(), tenant.timezone);
    const range = { gte: toDbDate(start), lte: toDbDate(end) };
    const [unfinalized, pendingLeave, pendingOt, noSalary, summaries] = await Promise.all([
      this.db.tenant.attendanceDay.count({ where: { attendanceDate: range, isFinalized: false } }),
      this.db.tenant.leaveRequest.count({ where: { status: 'PENDING', fromDate: { lte: toDbDate(end) }, toDate: { gte: toDbDate(start) } } }),
      this.db.tenant.attendanceDay.count({ where: { attendanceDate: range, otState: 'PENDING' } }),
      this.db.tenant.employee.count({ where: { status: { in: ['ACTIVE', 'INVITED'] }, salaryAssignments: { none: {} } } }),
      this.db.tenant.employeePaySummary.findMany({ where: { periodStart: toDbDate(start) }, select: { flags: true } }),
    ]);
    const warnings = [
      today <= end ? { code: 'MONTH_NOT_ENDED', message: 'The month has not ended yet.' } : null,
      unfinalized > 0 ? { code: 'UNFINALIZED_DAYS', message: `${unfinalized} attendance days are still open.` } : null,
      pendingLeave > 0 ? { code: 'PENDING_LEAVE', message: `${pendingLeave} leave requests are pending.` } : null,
      pendingOt > 0 ? { code: 'PENDING_OT', message: `${pendingOt} overtime entries await a decision.` } : null,
      noSalary > 0 ? { code: 'NO_SALARY', message: `${noSalary} employees have no salary set.` } : null,
      summaries.some((s) => s.flags.includes('NEGATIVE_NET')) ? { code: 'NEGATIVE_NET', message: 'Some employees have a negative net.' } : null,
    ].filter((w): w is { code: string; message: string } => w !== null);
    return { month, warnings, canLock: today > start };
  }

  async lock(month: string) {
    const { start } = monthRange(month);
    const check = await this.lockCheck(month);
    if (!check.canLock) throw new AppError('CONFLICT', 'A month can only be locked after it has started.');
    await this.recomputeTenantMonth(month);
    const summaries = await this.db.tenant.employeePaySummary.findMany({ where: { periodStart: toDbDate(start) } });
    const totals = {
      employees: summaries.length,
      netEarned: money(summaries.reduce((acc, s) => acc.plus(s.netEarned), new Decimal(0))),
      lopDays: num(summaries.reduce((acc, s) => acc.plus(s.lopDays), new Decimal(0))),
    };
    await this.db.tenant.$transaction(async (tx) => {
      for (const s of summaries) {
        await tx.employeePaySummary.update({ where: { id: s.id }, data: { status: 'LOCKED', snapshot: JSON.parse(JSON.stringify(s)) as Prisma.InputJsonValue } });
      }
      await tx.payPeriod.update({
        where: { tenantId_month: { tenantId: requireTenantId(), month: toDbDate(start) } },
        data: { status: 'LOCKED', lockedAt: new Date(), lockedById: requireTenantUser().membershipId, lockWarnings: check.warnings, totals },
      });
      await tx.attendanceDay.updateMany({ where: { attendanceDate: { gte: toDbDate(start), lte: toDbDate(monthRange(month).end) } }, data: { periodLocked: true } });
      await this.audit.record({ action: 'pay.period.lock', entityType: 'pay_period', entityId: month, after: { totals, warnings: check.warnings } }, tx);
    });
    return { month, status: 'LOCKED', totals };
  }

  async unlock(month: string, reason: string) {
    const { start, end } = monthRange(month);
    const period = await this.db.tenant.payPeriod.findUnique({ where: { tenantId_month: { tenantId: requireTenantId(), month: toDbDate(start) } } });
    if (!period || period.status !== 'LOCKED') throw new AppError('CONFLICT', 'This month is not locked.');
    await this.db.tenant.$transaction(async (tx) => {
      await tx.payPeriod.update({ where: { id: period.id }, data: { status: 'OPEN', unlockCount: { increment: 1 }, lastUnlockReason: reason } });
      await tx.employeePaySummary.updateMany({ where: { payPeriodId: period.id }, data: { status: 'OPEN' } });
      await tx.attendanceDay.updateMany({ where: { attendanceDate: { gte: toDbDate(start), lte: toDbDate(end) } }, data: { periodLocked: false } });
      await this.audit.record({ action: 'pay.period.unlock', entityType: 'pay_period', entityId: month, reason }, tx);
    });
    await this.queues.add(QUEUE.PAY, 'recompute-month', { tenantId: requireTenantId(), month });
    return { month, status: 'OPEN' };
  }

  async periods() {
    const rows = await this.db.tenant.payPeriod.findMany({ orderBy: { month: 'desc' }, take: 24 });
    return rows.map((p) => ({ month: p.month.toISOString().slice(0, 7), status: p.status, lockedAt: iso(p.lockedAt), totals: p.totals }));
  }

  private async ensureSummary(employeeId: string, month: string): Promise<EmployeePaySummary | null> {
    const existing = await this.db.tenant.employeePaySummary.findUnique({ where: { employeeId_periodStart: { employeeId, periodStart: toDbDate(`${month}-01`) } } });
    if (existing && (existing.status === 'LOCKED' || Date.now() - existing.computedAt.getTime() < 60_000)) return existing;
    return (await this.recomputeEmployeeMonth(employeeId, month)) ?? existing;
  }

  private async openPeriod(month: string) {
    const start = toDbDate(`${month}-01`);
    const period = await this.db.tenant.payPeriod.upsert({
      where: { tenantId_month: { tenantId: requireTenantId(), month: start } },
      update: {},
      create: { tenantId: requireTenantId(), month: start },
    });
    if (period.status === 'LOCKED') throw new AppError('PERIOD_LOCKED');
    return period;
  }

  private async queueRecompute(employeeId: string, month: string): Promise<void> {
    const job: RecomputePayJob = { tenantId: requireTenantId(), employeeId, month };
    await this.queues.add(QUEUE.PAY, 'recompute-employee', job, { jobId: `pay-${employeeId}-${month}-${Date.now()}` });
  }

  private summaryDto(e: { id: string; fullName: string; employeeCode: string | null; branch?: { name: string } | null; department?: { name: string } | null }, s: EmployeePaySummary) {
    return {
      employee: { id: e.id, fullName: e.fullName, employeeCode: e.employeeCode, branch: e.branch?.name ?? null, department: e.department?.name ?? null },
      status: s.status,
      basis: s.salaryBasis,
      rate: money(s.rate),
      divisor: num(s.divisor),
      employedDays: num(s.employedDays),
      presentDays: num(s.presentDays),
      halfDays: num(s.halfDays),
      paidHolidayDays: num(s.paidHolidayDays),
      weeklyOffDays: num(s.weeklyOffDays),
      paidLeaveDays: num(s.paidLeaveDays),
      unpaidLeaveDays: num(s.unpaidLeaveDays),
      absentDays: num(s.absentDays),
      lopDays: num(s.lopDays),
      payableDays: num(s.payableDays),
      workedMinutes: s.workedMinutes,
      otMinutes: s.otApprovedMinutes,
      baseEarned: money(s.baseEarned),
      otEarned: money(s.otEarned),
      additions: money(s.additions),
      deductions: money(s.deductions),
      netEarned: money(s.netEarned),
      projectedNet: money(s.projectedNet),
      mtdThrough: dateOnly(s.mtdThrough),
      flags: s.flags,
      computedAt: iso(s.computedAt),
      hasFeatureHint: !!currentContext()?.features?.EMPLOYEE_EARNINGS_VIEW,
    };
  }
}
