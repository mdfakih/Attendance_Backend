import { Injectable } from '@nestjs/common';
import type {
  LeaveApplyInput,
  LeaveApplyOnBehalfInput,
  LeaveBalanceAdjustInput,
  LeaveListQuery,
  LeaveTypeInput,
} from '@attendance/contracts';
import { Decimal } from 'decimal.js';
import { AuditService } from '../../core/audit/audit.service.js';
import { employeeScopeWhere, isInScope } from '../../core/auth/scope.js';
import { currentContext, requireContext, requireEmployee, requireTenantId, requireTenantUser } from '../../core/context/request-context.js';
import { DbService, type TenantTx } from '../../core/database/db.service.js';
import { AppError, notFound } from '../../core/http/app-error.js';
import { QUEUE, type RecomputeRangeJob } from '../../core/queue/queues.js';
import { QueueService } from '../../core/queue/queue.service.js';
import { dateOnly, iso, num } from '../../common/serialize.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { isValidSpan, leaveFractions, totalLeaveDays } from '../../engines/leave/leave-days.js';
import { addDays, localDateOf, toDbDate } from '../../engines/time/dates.js';
import { DayInputsLoader } from '../attendance/day-inputs.loader.js';
import { classifyDay } from '../../engines/attendance/calendar.js';

@Injectable()
export class LeaveService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly loader: DayInputsLoader,
    private readonly queues: QueueService,
  ) {}

  // ---- Types -------------------------------------------------------------------

  types(activeOnly = false) {
    return this.db.tenant.leaveType.findMany({ where: activeOnly ? { active: true } : {}, orderBy: { code: 'asc' } }).then((rows) =>
      rows.map((t) => ({
        ...t,
        annualQuota: num(t.annualQuota),
        monthlyAccrual: num(t.monthlyAccrual),
        carryForwardCap: num(t.carryForwardCap),
        maxNegativeBalance: num(t.maxNegativeBalance),
      })),
    );
  }

  async createType(input: LeaveTypeInput) {
    const row = await this.db.tenant.leaveType.create({ data: { ...this.typeData(input), tenantId: requireTenantId() } });
    await this.audit.record({ action: 'leave.type.create', entityType: 'leave_type', entityId: row.id, after: row });
    return row;
  }

  async updateType(id: string, input: LeaveTypeInput) {
    const before = await this.db.tenant.leaveType.findUnique({ where: { id } });
    if (!before) throw notFound('Leave type');
    const after = await this.db.tenant.leaveType.update({ where: { id }, data: this.typeData(input) });
    await this.audit.record({ action: 'leave.type.update', entityType: 'leave_type', entityId: id, before, after });
    return after;
  }

  private typeData(input: LeaveTypeInput) {
    return {
      code: input.code,
      name: input.name,
      isPaid: input.isPaid,
      allowHalfDay: input.allowHalfDay,
      accrualMode: input.accrualMode,
      annualQuota: input.annualQuota == null ? null : new Decimal(input.annualQuota),
      monthlyAccrual: input.monthlyAccrual == null ? null : new Decimal(input.monthlyAccrual),
      carryForwardCap: input.carryForwardCap == null ? null : new Decimal(input.carryForwardCap),
      maxNegativeBalance: new Decimal(input.maxNegativeBalance),
      backdateLimitDays: input.backdateLimitDays,
      countNonWorkingDays: input.countNonWorkingDays,
      active: input.active,
    };
  }

  // ---- Balances -----------------------------------------------------------------

  async balances(employeeId: string, year: number) {
    const [types, rows] = await Promise.all([
      this.db.tenant.leaveType.findMany({ where: { active: true }, orderBy: { code: 'asc' } }),
      this.db.tenant.leaveBalance.findMany({ where: { employeeId, leaveYear: year } }),
    ]);
    const byType = new Map(rows.map((r) => [r.leaveTypeId, r]));
    return types.map((t) => {
      const b = byType.get(t.id);
      return {
        leaveTypeId: t.id,
        code: t.code,
        name: t.name,
        isPaid: t.isPaid,
        allowHalfDay: t.allowHalfDay,
        balance: num(b?.balance) ?? 0,
        pending: num(b?.pending) ?? 0,
        used: num(b?.used) ?? 0,
        accrued: num(b?.accrued) ?? 0,
        unlimited: t.accrualMode === 'NONE' && Number(t.maxNegativeBalance) >= 365,
      };
    });
  }

  async adjustBalance(input: LeaveBalanceAdjustInput) {
    await this.employeeInScope(input.employeeId);
    const year = new Date().getFullYear();
    await this.db.tenant.$transaction(async (tx) => {
      await this.ledger(tx, { employeeId: input.employeeId, leaveTypeId: input.leaveTypeId, year, entryType: 'ADJUSTMENT', days: new Decimal(input.days), reason: input.reason });
      await this.audit.record({ action: 'leave.balance.adjust', entityType: 'employee', entityId: input.employeeId, after: input, reason: input.reason }, tx);
    });
    return this.balances(input.employeeId, year);
  }

  /** Credits yearly quotas for a leave year (idempotent per employee/type/year). */
  async accrueYear(tenantId: string, year: number): Promise<number> {
    const types = await this.db.tenant.leaveType.findMany({ where: { active: true, accrualMode: { in: ['FIXED_QUOTA', 'YEARLY_ACCRUAL'] } } });
    const employees = await this.db.tenant.employee.findMany({ where: { status: { in: ['ACTIVE', 'INVITED'] } }, select: { id: true, dateOfJoining: true } });
    let credited = 0;
    for (const type of types) {
      const quota = type.annualQuota ? new Decimal(type.annualQuota) : null;
      if (!quota) continue;
      for (const e of employees) {
        const joined = dateOnly(e.dateOfJoining) as string;
        const monthsLeft = joined.startsWith(String(year)) ? 12 - Number(joined.slice(5, 7)) + 1 : 12;
        const days = quota.mul(monthsLeft).div(12).toDecimalPlaces(1);
        const key = `${e.id}:${type.id}:ACCRUAL:${year}`;
        const exists = await this.db.tenant.leaveLedger.findUnique({ where: { idempotencyKey: key } });
        if (exists) continue;
        await this.db.tenant.$transaction((tx) =>
          this.ledger(tx, { employeeId: e.id, leaveTypeId: type.id, year, entryType: 'ACCRUAL', days, periodKey: String(year), idempotencyKey: key, tenantId }),
        );
        credited += 1;
      }
    }
    return credited;
  }

  /** Credits monthly accruals (idempotent per employee/type/month). */
  async accrueMonth(tenantId: string, month: string): Promise<number> {
    const types = await this.db.tenant.leaveType.findMany({ where: { active: true, accrualMode: 'MONTHLY_ACCRUAL', monthlyAccrual: { not: null } } });
    const employees = await this.db.tenant.employee.findMany({ where: { status: { in: ['ACTIVE', 'INVITED'] } }, select: { id: true } });
    let credited = 0;
    for (const type of types) {
      for (const e of employees) {
        const key = `${e.id}:${type.id}:ACCRUAL:${month}`;
        if (await this.db.tenant.leaveLedger.findUnique({ where: { idempotencyKey: key } })) continue;
        await this.db.tenant.$transaction((tx) =>
          this.ledger(tx, {
            employeeId: e.id,
            leaveTypeId: type.id,
            year: Number(month.slice(0, 4)),
            entryType: 'ACCRUAL',
            days: new Decimal(type.monthlyAccrual as Decimal),
            periodKey: month,
            idempotencyKey: key,
            tenantId,
          }),
        );
        credited += 1;
      }
    }
    return credited;
  }

  // ---- Requests -----------------------------------------------------------------

  async myRequests() {
    const { employeeId } = requireEmployee();
    const rows = await this.db.tenant.leaveRequest.findMany({ where: { employeeId }, orderBy: { fromDate: 'desc' }, take: 100, include: { employee: false } });
    return this.decorate(rows);
  }

  async apply(input: LeaveApplyInput) {
    const { employeeId } = requireEmployee();
    return this.createRequest(employeeId, input, 'EMPLOYEE', employeeId, false);
  }

  async applyOnBehalf(input: LeaveApplyOnBehalfInput) {
    await this.employeeInScope(input.employeeId);
    const { membershipId } = requireTenantUser();
    return this.createRequest(input.employeeId, input, 'TENANT_USER', membershipId, true);
  }

  async list(query: LeaveListQuery) {
    const where: Prisma.LeaveRequestWhereInput = {
      employee: employeeScopeWhere(),
      ...(query.status ? { status: query.status } : {}),
      ...(query.employeeId ? { employeeId: query.employeeId } : {}),
      ...(query.from ? { toDate: { gte: toDbDate(query.from) } } : {}),
      ...(query.to ? { fromDate: { lte: toDbDate(query.to) } } : {}),
    };
    const [rows, total] = await Promise.all([
      this.db.tenant.leaveRequest.findMany({ where, orderBy: [{ status: 'asc' }, { fromDate: 'desc' }], skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
      this.db.tenant.leaveRequest.count({ where }),
    ]);
    return { items: await this.decorate(rows), total };
  }

  async decide(requestId: string, decision: 'APPROVED' | 'REJECTED', note?: string) {
    const request = await this.db.tenant.leaveRequest.findUnique({ where: { id: requestId }, include: { employee: true } });
    if (!request || !isInScope(request.employee)) throw notFound('Leave request');
    if (request.status !== 'PENDING') throw new AppError('CONFLICT', 'This request was already decided.');
    const { membershipId } = requireTenantUser();
    const tenantId = requireTenantId();
    await this.db.tenant.$transaction(async (tx) => {
      await tx.leaveRequest.update({ where: { id: requestId }, data: { status: decision, decidedById: membershipId, decidedAt: new Date(), decisionNote: note } });
      const year = Number(dateOnly(request.fromDate)?.slice(0, 4));
      await this.movePending(tx, request.employeeId, request.leaveTypeId, year, new Decimal(request.days).neg());
      if (decision === 'APPROVED') {
        await this.ledger(tx, { employeeId: request.employeeId, leaveTypeId: request.leaveTypeId, year, entryType: 'DEBIT', days: new Decimal(request.days).neg(), leaveRequestId: requestId, tenantId });
      }
      await this.audit.record({ action: `leave.request.${decision.toLowerCase()}`, entityType: 'leave_request', entityId: requestId, reason: note }, tx);
    });
    if (decision === 'APPROVED') await this.recompute(request.employeeId, dateOnly(request.fromDate) as string, dateOnly(request.toDate) as string);
    await this.queues.add(QUEUE.NOTIFY, 'push', {
      tenantId,
      employeeId: request.employeeId,
      title: decision === 'APPROVED' ? 'Leave approved' : 'Leave not approved',
      body: `${dateOnly(request.fromDate)} to ${dateOnly(request.toDate)}${note ? `: ${note}` : ''}`,
      data: { type: 'LEAVE_DECISION', requestId },
    });
    return { id: requestId, status: decision };
  }

  async cancel(requestId: string) {
    const ctx = requireContext();
    const request = await this.db.tenant.leaveRequest.findUnique({ where: { id: requestId }, include: { employee: true } });
    if (!request) throw notFound('Leave request');
    const byEmployee = ctx.realm === 'EMPLOYEE';
    if (byEmployee && request.employeeId !== ctx.employee?.employeeId) throw notFound('Leave request');
    if (!byEmployee && !isInScope(request.employee)) throw notFound('Leave request');
    if (request.status === 'CANCELLED' || request.status === 'REJECTED') throw new AppError('CONFLICT', 'This request is already closed.');
    const today = localDateOf(new Date(), (await this.db.platform.tenant.findUniqueOrThrow({ where: { id: request.tenantId } })).timezone);
    if (byEmployee && (dateOnly(request.fromDate) as string) <= today) {
      throw new AppError('CONFLICT', 'Leave that has started can only be cancelled by your employer.');
    }
    await this.db.tenant.$transaction(async (tx) => {
      const year = Number(dateOnly(request.fromDate)?.slice(0, 4));
      await tx.leaveRequest.update({ where: { id: requestId }, data: { status: 'CANCELLED', cancelledByActor: ctx.actor.type, cancelledAt: new Date() } });
      if (request.status === 'PENDING') {
        await this.movePending(tx, request.employeeId, request.leaveTypeId, year, new Decimal(request.days).neg());
      } else {
        await this.ledger(tx, { employeeId: request.employeeId, leaveTypeId: request.leaveTypeId, year, entryType: 'CREDIT', days: new Decimal(request.days), leaveRequestId: requestId, tenantId: request.tenantId });
      }
      await this.audit.record({ action: 'leave.request.cancel', entityType: 'leave_request', entityId: requestId }, tx);
    });
    if (request.status === 'APPROVED') await this.recompute(request.employeeId, dateOnly(request.fromDate) as string, dateOnly(request.toDate) as string);
    return { id: requestId, status: 'CANCELLED' };
  }

  // ---- Internals --------------------------------------------------------------------

  private async createRequest(employeeId: string, input: LeaveApplyInput, actorType: 'EMPLOYEE' | 'TENANT_USER', actorId: string, autoApprove: boolean) {
    const tenantId = requireTenantId();
    const type = await this.db.tenant.leaveType.findUnique({ where: { id: input.leaveTypeId } });
    if (!type || !type.active) throw new AppError('VALIDATION_FAILED', 'Unknown leave type.');
    const span = { fromDate: input.fromDate, fromPart: input.fromPart, toDate: input.toDate, toPart: input.toPart };
    if (!isValidSpan(span, type.allowHalfDay)) throw new AppError('VALIDATION_FAILED', 'Invalid half-day selection for this leave type.');
    const tenant = await this.db.platform.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    const today = localDateOf(new Date(), tenant.timezone);
    if (actorType === 'EMPLOYEE' && input.fromDate < addDays(today, -type.backdateLimitDays)) throw new AppError('LEAVE_BACKDATE_LIMIT');
    const locked = await this.db.tenant.payPeriod.count({ where: { status: 'LOCKED', month: { gte: toDbDate(`${input.fromDate.slice(0, 7)}-01`), lte: toDbDate(`${input.toDate.slice(0, 7)}-01`) } } });
    if (locked > 0) throw new AppError('PERIOD_LOCKED');
    const ctx = await this.loader.load(employeeId, input.fromDate, input.toDate);
    if (!ctx) throw notFound('Employee');
    const fractions = leaveFractions(span, (d) => {
      const inputs = ctx.days.get(d);
      return inputs ? classifyDay(d, inputs.holiday, inputs.weeklyOffRules).dayType : 'WORKING';
    }, type.countNonWorkingDays);
    const days = totalLeaveDays(fractions);
    if (days <= 0) throw new AppError('VALIDATION_FAILED', 'The selected dates have no working days.');
    const year = Number(input.fromDate.slice(0, 4));
    const request = await this.db.tenant.$transaction(async (tx) => {
      await this.db.lock(tx, `leave:${employeeId}`);
      const overlap = await tx.leaveRequest.count({
        where: { employeeId, status: { in: ['PENDING', 'APPROVED'] }, fromDate: { lte: toDbDate(input.toDate) }, toDate: { gte: toDbDate(input.fromDate) } },
      });
      if (overlap > 0) throw new AppError('LEAVE_OVERLAP');
      const balance = await tx.leaveBalance.findUnique({ where: { employeeId_leaveTypeId_leaveYear: { employeeId, leaveTypeId: type.id, leaveYear: year } } });
      const available = new Decimal(balance?.balance ?? 0).minus(balance?.pending ?? 0).minus(days);
      if (type.accrualMode !== 'NONE' && available.lessThan(new Decimal(type.maxNegativeBalance).neg())) throw new AppError('LEAVE_INSUFFICIENT_BALANCE');
      const row = await tx.leaveRequest.create({
        data: {
          tenantId,
          employeeId,
          leaveTypeId: type.id,
          fromDate: toDbDate(input.fromDate),
          fromPart: input.fromPart,
          toDate: toDbDate(input.toDate),
          toPart: input.toPart,
          days: new Decimal(days),
          reason: input.reason,
          status: autoApprove ? 'APPROVED' : 'PENDING',
          appliedByActor: actorType,
          appliedById: actorId,
          decidedById: autoApprove ? actorId : null,
          decidedAt: autoApprove ? new Date() : null,
        },
      });
      if (autoApprove) {
        await this.ledger(tx, { employeeId, leaveTypeId: type.id, year, entryType: 'DEBIT', days: new Decimal(days).neg(), leaveRequestId: row.id, tenantId });
      } else {
        await this.movePending(tx, employeeId, type.id, year, new Decimal(days));
      }
      await this.audit.record({ action: autoApprove ? 'leave.request.apply_on_behalf' : 'leave.request.apply', entityType: 'leave_request', entityId: row.id, after: { days } }, tx);
      return row;
    });
    if (autoApprove) await this.recompute(employeeId, input.fromDate, input.toDate);
    return { id: request.id, status: request.status, days };
  }

  private async ledger(
    tx: TenantTx,
    e: { employeeId: string; leaveTypeId: string; year: number; entryType: 'ACCRUAL' | 'DEBIT' | 'CREDIT' | 'ADJUSTMENT'; days: Decimal; reason?: string; periodKey?: string; leaveRequestId?: string; idempotencyKey?: string; tenantId?: string },
  ): Promise<void> {
    const tenantId = e.tenantId ?? requireTenantId();
    const actor = currentContext()?.actor;
    await tx.leaveLedger.create({
      data: {
        tenantId,
        employeeId: e.employeeId,
        leaveTypeId: e.leaveTypeId,
        leaveYear: e.year,
        entryType: e.entryType,
        days: e.days,
        periodKey: e.periodKey,
        leaveRequestId: e.leaveRequestId,
        reason: e.reason,
        actorType: actor?.type ?? 'SYSTEM',
        actorId: actor?.id ?? null,
        idempotencyKey: e.idempotencyKey,
      },
    });
    const field = e.entryType === 'ACCRUAL' ? 'accrued' : e.entryType === 'DEBIT' ? 'used' : e.entryType === 'CREDIT' ? 'credited' : 'adjusted';
    const delta = e.entryType === 'DEBIT' ? e.days.neg() : e.days;
    await tx.leaveBalance.upsert({
      where: { employeeId_leaveTypeId_leaveYear: { employeeId: e.employeeId, leaveTypeId: e.leaveTypeId, leaveYear: e.year } },
      update: { [field]: { increment: delta }, balance: { increment: e.days } },
      create: { tenantId, employeeId: e.employeeId, leaveTypeId: e.leaveTypeId, leaveYear: e.year, [field]: delta, balance: e.days },
    });
  }

  private async movePending(tx: TenantTx, employeeId: string, leaveTypeId: string, year: number, delta: Decimal): Promise<void> {
    await tx.leaveBalance.upsert({
      where: { employeeId_leaveTypeId_leaveYear: { employeeId, leaveTypeId, leaveYear: year } },
      update: { pending: { increment: delta } },
      create: { tenantId: requireTenantId(), employeeId, leaveTypeId, leaveYear: year, pending: delta },
    });
  }

  private async recompute(employeeId: string, from: string, to: string): Promise<void> {
    const job: RecomputeRangeJob = { tenantId: requireTenantId(), employeeIds: [employeeId], from, to };
    await this.queues.add(QUEUE.ATTENDANCE, 'recompute-range', job);
  }

  private async decorate(rows: Array<Prisma.LeaveRequestGetPayload<object>>) {
    const [employees, types] = await Promise.all([
      this.db.tenant.employee.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.employeeId))] } }, select: { id: true, fullName: true, employeeCode: true } }),
      this.db.tenant.leaveType.findMany({ select: { id: true, code: true, name: true, isPaid: true } }),
    ]);
    const emp = new Map(employees.map((e) => [e.id, e]));
    const typ = new Map(types.map((t) => [t.id, t]));
    return rows.map((r) => ({
      id: r.id,
      employee: emp.get(r.employeeId) ?? null,
      leaveType: typ.get(r.leaveTypeId) ?? null,
      fromDate: dateOnly(r.fromDate),
      fromPart: r.fromPart,
      toDate: dateOnly(r.toDate),
      toPart: r.toPart,
      days: num(r.days),
      reason: r.reason,
      status: r.status,
      appliedByActor: r.appliedByActor,
      decisionNote: r.decisionNote,
      decidedAt: iso(r.decidedAt),
      createdAt: iso(r.createdAt),
    }));
  }

  private async employeeInScope(employeeId: string) {
    const employee = await this.db.tenant.employee.findUnique({ where: { id: employeeId } });
    if (!employee || !isInScope(employee)) throw notFound('Employee');
    return employee;
  }
}
