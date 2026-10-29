import { Injectable } from '@nestjs/common';
import type { RegularizationDecisionInput, RegularizationListQuery, RegularizationRequestInput } from '@attendance/contracts';
import { AuditService } from '../../core/audit/audit.service.js';
import { employeeScopeWhere, isInScope } from '../../core/auth/scope.js';
import { currentContext, requireEmployee, requireTenantId, requireTenantUser } from '../../core/context/request-context.js';
import { DbService } from '../../core/database/db.service.js';
import { AppError, notFound } from '../../core/http/app-error.js';
import { NotifyService } from '../../core/notify/notify.service.js';
import { dateOnly, iso } from '../../common/serialize.js';
import { isUniqueViolation } from '../../common/unique-retry.js';
import type { AttendanceDay, Prisma, RegularizationRequest } from '../../generated/prisma/client.js';
import { monthOf, monthRange, toDbDate } from '../../engines/time/dates.js';
import { AttendanceDayService, type WrittenDay } from './attendance-day.service.js';
import { AttendanceSettleService } from './attendance-settle.service.js';

/** "1h 20m", "45m". */
export function formatMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function liveKey(employeeId: string, date: string): string {
  return `${employeeId}:${date}`;
}

/**
 * Time worked outside working hours is recorded but not counted. The employee asks, with a
 * reason, for it to be counted; the employer approves all or part of it, or rejects it.
 */
@Injectable()
export class RegularizationService {
  constructor(
    private readonly db: DbService,
    private readonly days: AttendanceDayService,
    private readonly settle: AttendanceSettleService,
    private readonly notify: NotifyService,
    private readonly audit: AuditService,
  ) {}

  // ---- Employee (mobile) ----------------------------------------------------------

  /** Days of the month with outside-hours time, and the employee's request for each. */
  async employeeMonth(month: string) {
    const { employeeId } = requireEmployee();
    const { start, end } = monthRange(month);
    await this.settle.settleEmployee(employeeId, start, end);
    const range = { gte: toDbDate(start), lte: toDbDate(end) };
    const [days, requests] = await Promise.all([
      this.db.tenant.attendanceDay.findMany({
        where: { employeeId, attendanceDate: range, regState: { not: 'NOT_APPLICABLE' } },
        orderBy: { attendanceDate: 'desc' },
      }),
      this.db.tenant.regularizationRequest.findMany({ where: { employeeId, attendanceDate: range, liveKey: { not: null } } }),
    ]);
    const byDate = new Map(requests.map((r) => [dateOnly(r.attendanceDate), r]));
    return days.map((d) => ({ ...this.dayDto(d), request: this.requestDto(byDate.get(dateOnly(d.attendanceDate)) ?? null) }));
  }

  async request(input: RegularizationRequestInput) {
    const { employeeId } = requireEmployee();
    const tenantId = requireTenantId();
    await this.assertMonthOpen(input.date);
    await this.settle.settleEmployee(employeeId, input.date, input.date);
    const day = await this.findDay(employeeId, input.date);
    if (!day || day.regState === 'NOT_APPLICABLE') throw new AppError('REGULARIZATION_UNAVAILABLE');
    if (day.regState !== 'AVAILABLE') throw new AppError('REGULARIZATION_EXISTS');
    let created: RegularizationRequest;
    try {
      created = await this.db.tenant.regularizationRequest.create({
        data: {
          tenantId,
          employeeId,
          attendanceDate: toDbDate(input.date),
          outsideMinutes: day.outsideMinutes,
          reason: input.reason,
          liveKey: liveKey(employeeId, input.date),
        },
      });
    } catch (error: unknown) {
      if (isUniqueViolation(error)) throw new AppError('REGULARIZATION_EXISTS');
      throw error;
    }
    await this.audit.record({
      action: 'regularization.request',
      entityType: 'employee',
      entityId: employeeId,
      after: { date: input.date, outsideMinutes: day.outsideMinutes },
      reason: input.reason,
    });
    await this.refreshDay(employeeId, input.date);
    return this.requestDto(created);
  }

  async cancel(id: string) {
    const { employeeId } = requireEmployee();
    const request = await this.db.tenant.regularizationRequest.findUnique({ where: { id } });
    if (!request || request.employeeId !== employeeId) throw notFound('Request');
    const date = dateOnly(request.attendanceDate) as string;
    // Conditional on PENDING so a withdrawal racing an approval cannot undo it.
    const withdrawn = await this.db.tenant.regularizationRequest.updateMany({
      where: { id, employeeId, status: 'PENDING' },
      data: { status: 'CANCELLED', liveKey: null },
    });
    if (withdrawn.count === 0) throw new AppError('CONFLICT', 'Only a pending request can be withdrawn.');
    await this.audit.record({ action: 'regularization.cancel', entityType: 'employee', entityId: employeeId, after: { date } });
    await this.refreshDay(employeeId, date);
    return { id, status: 'CANCELLED' };
  }

  /** Tells the employee once per day when a punch leaves time outside working hours that needs a request. */
  async noticeOutsideTime(employeeId: string, written: WrittenDay | null): Promise<void> {
    if (!written || written.result.regState !== 'AVAILABLE' || written.previousRegState === 'AVAILABLE') return;
    // Nothing to ask for when the client has extra time requests switched off.
    if (currentContext()?.features?.EXTRA_TIME === false) return;
    await this.notify.employee({
      tenantId: requireTenantId(),
      employeeId,
      title: 'Time outside working hours',
      body: `${formatMinutes(written.result.outsideMinutes)} on ${written.date} is outside your working hours and is not counted. If it was work, ask your employer to count it.`,
      data: { type: 'OUTSIDE_HOURS', date: written.date },
    });
  }

  // ---- Employer -------------------------------------------------------------------

  async list(query: RegularizationListQuery) {
    const where: Prisma.RegularizationRequestWhereInput = {
      ...(query.status ? { status: query.status } : { status: { not: 'CANCELLED' } }),
      ...(query.from || query.to
        ? { attendanceDate: { ...(query.from ? { gte: toDbDate(query.from) } : {}), ...(query.to ? { lte: toDbDate(query.to) } : {}) } }
        : {}),
      employee: {
        ...employeeScopeWhere(),
        ...(query.q
          ? { OR: [{ fullName: { contains: query.q, mode: 'insensitive' } }, { employeeCode: { contains: query.q, mode: 'insensitive' } }] }
          : {}),
      },
    };
    const [rows, total] = await Promise.all([
      this.db.tenant.regularizationRequest.findMany({
        where,
        include: { employee: { select: { id: true, fullName: true, employeeCode: true } } },
        orderBy: [{ attendanceDate: 'desc' }, { createdAt: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.db.tenant.regularizationRequest.count({ where }),
    ]);
    const days = await this.db.tenant.attendanceDay.findMany({
      where: { employeeId: { in: [...new Set(rows.map((r) => r.employeeId))] }, attendanceDate: { in: rows.map((r) => r.attendanceDate) } },
    });
    const dayOf = new Map(days.map((d) => [`${d.employeeId}:${dateOnly(d.attendanceDate)}`, d]));
    const items = rows.map((r) => {
      const day = dayOf.get(`${r.employeeId}:${dateOnly(r.attendanceDate)}`);
      return { ...this.requestDto(r), employee: r.employee, day: day ? this.dayDto(day) : null };
    });
    return { items, total };
  }

  pendingCount(): Promise<number> {
    return this.db.tenant.regularizationRequest.count({ where: { status: 'PENDING', employee: employeeScopeWhere() } });
  }

  async decide(id: string, input: RegularizationDecisionInput) {
    const request = await this.db.tenant.regularizationRequest.findUnique({ where: { id }, include: { employee: true } });
    if (!request || !isInScope(request.employee)) throw notFound('Request');
    if (request.status !== 'PENDING') throw new AppError('CONFLICT', 'This request was already decided.');
    const date = dateOnly(request.attendanceDate) as string;
    await this.assertMonthOpen(date);
    await this.settle.settleEmployee(request.employeeId, date, date);
    const outside = (await this.findDay(request.employeeId, date))?.outsideMinutes ?? 0;
    const approved = input.decision === 'APPROVED' ? Math.min(input.approvedMinutes ?? outside, outside) : 0;
    if (input.decision === 'APPROVED' && approved === 0) {
      throw new AppError('CONFLICT', 'There is no time outside working hours left to approve on this day.');
    }
    // Conditional on PENDING so two deciders (or a decision racing a withdrawal) cannot both win.
    const claimed = await this.db.tenant.regularizationRequest.updateMany({
      where: { id, status: 'PENDING' },
      data: {
        status: input.decision,
        approvedMinutes: approved,
        decidedById: requireTenantUser().membershipId,
        decidedAt: new Date(),
        decisionNote: input.note ?? null,
      },
    });
    if (claimed.count === 0) throw new AppError('CONFLICT', 'This request was already decided or withdrawn.');
    const updated = await this.db.tenant.regularizationRequest.findUniqueOrThrow({ where: { id } });
    await this.audit.record({
      action: `regularization.${input.decision.toLowerCase()}`,
      entityType: 'employee',
      entityId: request.employeeId,
      after: { date, approvedMinutes: approved },
      reason: input.note,
    });
    const written = await this.refreshDay(request.employeeId, date);
    const note = input.note ? `: ${input.note}` : '';
    await this.notify.employee({
      tenantId: requireTenantId(),
      employeeId: request.employeeId,
      title: input.decision === 'APPROVED' ? 'Extra time counted' : 'Extra time not counted',
      body:
        input.decision === 'APPROVED'
          ? `${formatMinutes(approved)} on ${date} now counts as working time${note}`
          : `Your time outside working hours on ${date} was not counted${note}`,
      data: { type: 'REGULARIZATION_DECISION', requestId: id, date },
    });
    return {
      ...this.requestDto(updated),
      day: written ? { workedMinutes: written.result.workedMinutes, status: written.result.finalStatus, otMinutes: written.result.otApprovedMinutes } : null,
    };
  }

  // ---- Helpers --------------------------------------------------------------------

  /** Flags the day first, so if the recompute fails the next read of the day still picks up the change. */
  private async refreshDay(employeeId: string, date: string): Promise<WrittenDay | null> {
    await this.days.markStale([employeeId], date, date);
    return this.days.recomputeDay(employeeId, date);
  }

  private findDay(employeeId: string, date: string): Promise<AttendanceDay | null> {
    return this.db.tenant.attendanceDay.findUnique({ where: { employeeId_attendanceDate: { employeeId, attendanceDate: toDbDate(date) } } });
  }

  private async assertMonthOpen(date: string): Promise<void> {
    const locked = await this.db.tenant.payPeriod.count({ where: { month: toDbDate(`${monthOf(date)}-01`), status: 'LOCKED' } });
    if (locked > 0) throw new AppError('PERIOD_LOCKED');
  }

  private dayDto(d: AttendanceDay) {
    return {
      date: dateOnly(d.attendanceDate),
      status: d.finalStatus,
      dayType: d.dayType,
      expectedStartAt: iso(d.expectedStartAt),
      expectedEndAt: iso(d.expectedEndAt),
      firstPunchAt: iso(d.firstPunchAt),
      lastPunchAt: iso(d.lastPunchAt),
      workedMinutes: d.workedMinutes,
      outsideEarlyMinutes: d.outsideEarlyMinutes,
      outsideLateMinutes: d.outsideLateMinutes,
      outsideMinutes: d.outsideMinutes,
      regState: d.regState,
      regApprovedMinutes: d.regApprovedMinutes,
    };
  }

  private requestDto(r: RegularizationRequest | null) {
    if (!r) return null;
    return {
      id: r.id,
      date: dateOnly(r.attendanceDate),
      status: r.status,
      reason: r.reason,
      outsideMinutesAtRequest: r.outsideMinutes,
      approvedMinutes: r.approvedMinutes,
      decisionNote: r.decisionNote,
      createdAt: iso(r.createdAt),
      decidedAt: iso(r.decidedAt),
    };
  }
}
