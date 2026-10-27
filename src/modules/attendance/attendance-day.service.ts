import { Injectable } from '@nestjs/common';
import type { ManualMarkStatus } from '@attendance/contracts';
import { Decimal } from 'decimal.js';
import { sha256Hex } from '../../core/crypto/crypto.util.js';
import { DbService, type TenantTx } from '../../core/database/db.service.js';
import { QUEUE, type RecomputePayJob } from '../../core/queue/queues.js';
import { QueueService } from '../../core/queue/queue.service.js';
import type { AttendanceDay } from '../../generated/prisma/client.js';
import { classifyDay } from '../../engines/attendance/calendar.js';
import { ATTENDANCE_ENGINE_VERSION, computeDay, type DayResult } from '../../engines/attendance/compute-day.js';
import { shiftInstance } from '../../engines/attendance/shift.js';
import { type IsoDate, maxDate, minDate, monthOf, toDbDate } from '../../engines/time/dates.js';
import { DayInputsLoader, type EmployeeContext } from './day-inputs.loader.js';

const DEFAULT_DUTY_MINUTES = 480;

export interface WrittenDay {
  readonly date: IsoDate;
  readonly result: DayResult;
  readonly changed: boolean;
}

/** The only writer of attendance_days. Deterministic: same inputs → same row (hash-skipped). */
@Injectable()
export class AttendanceDayService {
  constructor(
    private readonly db: DbService,
    private readonly loader: DayInputsLoader,
    private readonly queues: QueueService,
  ) {}

  async recomputeDay(employeeId: string, date: IsoDate, tx?: TenantTx): Promise<WrittenDay | null> {
    const [day] = await this.recomputeRange(employeeId, date, date, tx);
    return day ?? null;
  }

  async recomputeRange(employeeId: string, from: IsoDate, to: IsoDate, tx?: TenantTx): Promise<WrittenDay[]> {
    const ctx = await this.loader.load(employeeId, from, to, tx);
    if (!ctx) return [];
    const start = maxDate(from, ctx.joinDate);
    const end = ctx.exitDate ? minDate(to, ctx.exitDate) : to;
    if (start > end) return [];
    const client = tx ?? this.db.tenant;
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
    await Promise.all([...months].map((month) => this.queuePay(ctx.tenantId, employeeId, month)));
    return written;
  }

  async queuePay(tenantId: string, employeeId: string, month: string): Promise<void> {
    const job: RecomputePayJob = { tenantId, employeeId, month };
    await this.queues.add(QUEUE.PAY, 'recompute-employee', job, {
      jobId: `pay-${employeeId}-${month}`,
      delay: 3000,
      removeOnComplete: true,
      removeOnFail: true,
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
    const otDecision =
      existing?.otDecidedAt && (existing.otState === 'APPROVED' || existing.otState === 'REJECTED')
        ? { state: existing.otState, approvedMinutes: existing.otApprovedMinutes }
        : null;
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
      otDecision,
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
    if (existing && existing.inputsHash === inputsHash) {
      return { date, result, changed: false };
    }
    await client.attendanceDay.upsert({
      where: { employeeId_attendanceDate: { employeeId: ctx.employeeId, attendanceDate: toDbDate(date) } },
      update: { ...data, inputsHash, computedAt: now },
      create: { ...data, tenantId: ctx.tenantId, employeeId: ctx.employeeId, attendanceDate: toDbDate(date), inputsHash, computedAt: now },
    });
    return { date, result, changed: true };
  }
}
