import { Injectable } from '@nestjs/common';
import type { ManualMarkStatus } from '@attendance/contracts';
import { Decimal } from 'decimal.js';
import { sha256Hex } from '../../core/crypto/crypto.util.js';
import { DbService, type TenantTx } from '../../core/database/db.service.js';
import type { AttendanceDay, RegState } from '../../generated/prisma/client.js';
import { classifyDay } from '../../engines/attendance/calendar.js';
import { ATTENDANCE_ENGINE_VERSION, computeDay, type DayResult } from '../../engines/attendance/compute-day.js';
import { shiftInstance } from '../../engines/attendance/shift.js';
import { type IsoDate, maxDate, minDate, monthOf, toDbDate } from '../../engines/time/dates.js';
import { DayInputsLoader, type EmployeeContext } from './day-inputs.loader.js';

const DEFAULT_DUTY_MINUTES = 480;
/** Long leave spans recompute many days in one transaction. */
const RECOMPUTE_TX_TIMEOUT_MS = 30_000;

/** Advisory-lock key serialising everything that writes an employee's punches or days. */
export function employeeDayLock(employeeId: string): string {
  return `punch:${employeeId}`;
}

export interface WrittenDay {
  readonly date: IsoDate;
  readonly result: DayResult;
  readonly changed: boolean;
  /** Regularization state before this write; null when the row is new. */
  readonly previousRegState: RegState | null;
}

/** The only writer of attendance_days. Deterministic: same inputs → same row (hash-skipped). */
@Injectable()
export class AttendanceDayService {
  constructor(
    private readonly db: DbService,
    private readonly loader: DayInputsLoader,
  ) {}

  async recomputeDay(employeeId: string, date: IsoDate, tx?: TenantTx): Promise<WrittenDay | null> {
    const [day] = await this.recomputeRange(employeeId, date, date, tx);
    return day ?? null;
  }

  /**
   * With a caller transaction, the caller must hold `employeeDayLock`. Without one, the work runs in its
   * own transaction under that lock, so a concurrent punch is either fully seen by this computation or
   * applied after it — a read-triggered recompute can never overwrite a newer punch.
   */
  async recomputeRange(employeeId: string, from: IsoDate, to: IsoDate, tx?: TenantTx): Promise<WrittenDay[]> {
    if (tx) return this.recomputeLocked(employeeId, from, to, tx);
    return this.db.tenant.$transaction(
      async (locked) => {
        await this.db.lock(locked, employeeDayLock(employeeId));
        return this.recomputeLocked(employeeId, from, to, locked);
      },
      { timeout: RECOMPUTE_TX_TIMEOUT_MS },
    );
  }

  private async recomputeLocked(employeeId: string, from: IsoDate, to: IsoDate, client: TenantTx): Promise<WrittenDay[]> {
    const ctx = await this.loader.load(employeeId, from, to, client);
    if (!ctx) return [];
    const start = maxDate(from, ctx.joinDate);
    const end = ctx.exitDate ? minDate(to, ctx.exitDate) : to;
    if (start > end) return [];
    const [existing, lockedMonths] = await Promise.all([
      client.attendanceDay.findMany({ where: { employeeId, attendanceDate: { gte: toDbDate(start), lte: toDbDate(end) } } }),
      client.payPeriod.findMany({ where: { status: 'LOCKED', month: { gte: toDbDate(`${monthOf(start)}-01`), lte: toDbDate(`${monthOf(end)}-01`) } } }),
    ]);
    const locked = new Set(lockedMonths.map((p) => p.month.toISOString().slice(0, 7)));
    const byDate = new Map(existing.map((d) => [d.attendanceDate.toISOString().slice(0, 10), d]));
    const now = new Date();
    const written: WrittenDay[] = [];
    for (const date of [...ctx.days.keys()].filter((d) => d >= start && d <= end)) {
      if (locked.has(monthOf(date))) continue;
      written.push(await this.writeOne(client, ctx, date, byDate.get(date) ?? null, now));
    }
    const months = new Set(written.filter((w) => w.changed).map((w) => monthOf(w.date)));
    await Promise.all([...months].map((month) => this.markPayStale(employeeId, month, client)));
    return written;
  }

  /** The employee's open pay summary for the month is recomputed on its next read. */
  async markPayStale(employeeId: string, month: string, client: TenantTx | DbService['tenant'] = this.db.tenant): Promise<void> {
    await client.employeePaySummary.updateMany({
      where: { employeeId, periodStart: toDbDate(`${month}-01`), status: 'OPEN' },
      data: { isStale: true },
    });
  }

  /**
   * Bulk changes (shifts, holidays, overrides) flag existing days instead of recomputing them inline;
   * the next read of those days recomputes them (see AttendanceSettleService).
   */
  async markStale(employeeIds: readonly string[] | 'ALL', from: IsoDate, to: IsoDate): Promise<void> {
    await this.db.tenant.attendanceDay.updateMany({
      where: {
        attendanceDate: { gte: toDbDate(from), lte: toDbDate(to) },
        periodLocked: false,
        ...(employeeIds === 'ALL' ? {} : { employeeId: { in: [...employeeIds] } }),
      },
      data: { needsRecompute: true },
    });
  }

  private async writeOne(
    client: TenantTx | DbService['tenant'],
    ctx: EmployeeContext,
    date: IsoDate,
    existing: AttendanceDay | null,
    now: Date,
  ): Promise<WrittenDay> {
    const inputs = ctx.days.get(date);
    if (!inputs) throw new Error(`Missing inputs for ${date}`);
    const cls = classifyDay(date, inputs.holiday, inputs.weeklyOffRules);
    const instance = shiftInstance(date, inputs.shift, ctx.timezone);
    const dutyMinutes = ctx.dutyMinutesOverride ?? inputs.shift?.dutyMinutes ?? DEFAULT_DUTY_MINUTES;
    const leave = inputs.leave && (cls.dayType === 'WORKING' || inputs.leave.countsNonWorking) ? inputs.leave : null;
    const isFinal = now >= instance.windowEndAt;
    const result = computeDay({
      dayType: cls.dayType,
      holidayPaid: cls.holiday?.isPaid ?? true,
      punchTimes: inputs.punchTimes,
      expectedStartAt: inputs.shift && !instance.implicit ? instance.startAt : null,
      expectedEndAt: inputs.shift && !instance.implicit ? instance.endAt : null,
      dutyMinutes,
      unpaidBreakMinutes: inputs.shift?.unpaidBreakMinutes ?? 0,
      isFlexible: inputs.shift?.isFlexible ?? true,
      policy: inputs.policy,
      overtimeEnabled: ctx.overtimeEnabled,
      leave: leave ? { fraction: leave.fraction, paid: leave.paid } : null,
      manualMark: inputs.manualMark ? { status: inputs.manualMark.status as ManualMarkStatus, leavePaid: inputs.manualMark.leavePaid } : null,
      regularization: inputs.regularization ? { status: inputs.regularization.status, approvedMinutes: inputs.regularization.approvedMinutes } : null,
      isFinal,
    });
    const leavePaid = inputs.manualMark ? inputs.manualMark.leavePaid : (leave?.paid ?? true);
    const data = {
      branchId: ctx.branchId,
      departmentId: ctx.departmentId,
      dayType: cls.dayType,
      holidayId: cls.holiday?.id ?? null,
      holidayPaid: cls.holiday?.isPaid ?? true,
      overrideId: inputs.override?.id ?? null,
      shiftId: inputs.shift?.id ?? null,
      policyId: inputs.policy.id,
      policyVersion: inputs.policy.version,
      expectedStartAt: instance.implicit ? null : instance.startAt,
      expectedEndAt: instance.implicit ? null : instance.endAt,
      windowEndAt: instance.windowEndAt,
      dutyMinutes,
      punchCount: result.punchCount,
      firstPunchAt: result.firstPunchAt,
      lastPunchAt: result.lastPunchAt,
      workedMinutes: result.workedMinutes,
      outsideEarlyMinutes: result.outsideEarlyMinutes,
      outsideLateMinutes: result.outsideLateMinutes,
      outsideMinutes: result.outsideMinutes,
      regState: result.regState,
      regApprovedMinutes: result.regApprovedMinutes,
      lateMinutes: result.lateMinutes,
      earlyLeaveMinutes: result.earlyLeaveMinutes,
      isLate: result.isLate,
      isMissingOut: result.isMissingOut,
      otMinutes: result.otMinutes,
      otState: result.otState,
      otApprovedMinutes: result.otApprovedMinutes,
      leaveRequestId: leave?.requestId ?? null,
      leaveTypeId: inputs.manualMark?.leaveTypeId ?? leave?.leaveTypeId ?? null,
      leaveFraction: new Decimal(result.leaveFraction),
      leavePaid,
      computedStatus: result.computedStatus,
      finalStatus: result.finalStatus,
      statusSource: result.statusSource,
      manualMarkId: inputs.manualMark?.id ?? null,
      paidFraction: new Decimal(result.paidFraction),
      lopFraction: new Decimal(result.lopFraction),
      flags: [...result.flags],
      isFinalized: isFinal,
      finalizedAt: isFinal ? (existing?.finalizedAt ?? now) : null,
      engineVersion: ATTENDANCE_ENGINE_VERSION,
    };
    const inputsHash = sha256Hex(JSON.stringify({ ...data, leaveFraction: result.leaveFraction, paidFraction: result.paidFraction, lopFraction: result.lopFraction }));
    const previousRegState = existing?.regState ?? null;
    if (existing && existing.inputsHash === inputsHash) {
      if (existing.needsRecompute) {
        await client.attendanceDay.update({ where: { id: existing.id }, data: { needsRecompute: false } });
      }
      return { date, result, changed: false, previousRegState };
    }
    await client.attendanceDay.upsert({
      where: { employeeId_attendanceDate: { employeeId: ctx.employeeId, attendanceDate: toDbDate(date) } },
      update: { ...data, needsRecompute: false, inputsHash, computedAt: now },
      create: { ...data, tenantId: ctx.tenantId, employeeId: ctx.employeeId, attendanceDate: toDbDate(date), inputsHash, computedAt: now },
    });
    return { date, result, changed: true, previousRegState };
  }
}
