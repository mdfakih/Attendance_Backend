import { Injectable } from '@nestjs/common';
import type { WeeklyOffRule } from '@attendance/contracts';
import { DbService, type TenantTx } from '../../core/database/db.service.js';
import { CacheService } from '../../core/redis/cache.service.js';
import type { AttendancePolicy, Shift } from '../../generated/prisma/client.js';
import type { DayPolicy } from '../../engines/attendance/compute-day.js';
import type { ShiftDefinition } from '../../engines/attendance/shift.js';
import { dateOnly } from '../../common/serialize.js';
import { eachDate, type IsoDate, toDbDate } from '../../engines/time/dates.js';

export const DEFAULT_POLICY: DayPolicy = {
  hoursMode: 'FIRST_IN_LAST_OUT',
  lateGraceMin: 10,
  earlyLeaveGraceMin: 10,
  fullDayMinMinutes: null,
  halfDayMinMinutes: 240,
  missingOutTreatment: 'ABSENT',
  otMinMinutes: 30,
  otRoundingMinutes: 15,
  otDailyCapMinutes: 240,
  otRequiresApproval: true,
  outsideMinMinutes: 15,
};

const DEFAULT_MAX_PUNCHES_PER_DAY = 6;
const TZ_CACHE_SEC = 300;

export interface DayInputs {
  readonly date: IsoDate;
  readonly shift: (ShiftDefinition & { readonly id: string }) | null;
  readonly policy: DayPolicy & {
    readonly id: string | null;
    readonly version: number | null;
    readonly minPunchGapSec: number;
    readonly blockMockLocation: boolean;
    readonly maxPunchesPerDay: number;
  };
  readonly weeklyOffRules: readonly WeeklyOffRule[];
  readonly holiday: { readonly id: string; readonly name: string; readonly isPaid: boolean } | null;
  readonly override: { readonly id: string; readonly allowPunch: boolean } | null;
  readonly leave: {
    readonly requestId: string;
    readonly leaveTypeId: string;
    readonly fraction: 0.5 | 1;
    readonly paid: boolean;
    readonly countsNonWorking: boolean;
  } | null;
  readonly manualMark: { readonly id: string; readonly status: string; readonly leaveTypeId: string | null; readonly leavePaid: boolean } | null;
  readonly regularization: { readonly id: string; readonly status: 'PENDING' | 'APPROVED' | 'REJECTED'; readonly approvedMinutes: number } | null;
  readonly punchTimes: readonly Date[];
}

export interface EmployeeContext {
  readonly employeeId: string;
  readonly tenantId: string;
  readonly timezone: string;
  readonly branchId: string;
  readonly departmentId: string | null;
  readonly dutyMinutesOverride: number | null;
  readonly joinDate: IsoDate;
  readonly exitDate: IsoDate | null;
  readonly overtimeEnabled: boolean;
  readonly days: ReadonlyMap<IsoDate, DayInputs>;
}

function toPolicy(p: AttendancePolicy | null): DayInputs['policy'] {
  if (!p) {
    return { ...DEFAULT_POLICY, id: null, version: null, minPunchGapSec: 60, blockMockLocation: true, maxPunchesPerDay: DEFAULT_MAX_PUNCHES_PER_DAY };
  }
  return {
    id: p.id,
    version: p.version,
    hoursMode: p.hoursMode,
    lateGraceMin: p.lateGraceMin,
    earlyLeaveGraceMin: p.earlyLeaveGraceMin,
    fullDayMinMinutes: p.fullDayMinMinutes,
    halfDayMinMinutes: p.halfDayMinMinutes,
    missingOutTreatment: p.missingOutTreatment,
    otMinMinutes: p.otMinMinutes,
    otRoundingMinutes: p.otRoundingMinutes,
    otDailyCapMinutes: p.otDailyCapMinutes,
    otRequiresApproval: p.otRequiresApproval,
    outsideMinMinutes: p.outsideMinMinutes,
    minPunchGapSec: p.minPunchGapSec,
    blockMockLocation: p.blockMockLocation,
    maxPunchesPerDay: p.maxPunchesPerDay,
  };
}

function toShift(s: Shift): ShiftDefinition & { id: string } {
  return {
    id: s.id,
    startTime: s.startTime,
    endTime: s.endTime,
    dutyMinutes: s.dutyMinutes,
    unpaidBreakMinutes: s.unpaidBreakMinutes,
    isFlexible: s.isFlexible,
    windowBeforeStartMin: s.windowBeforeStartMin,
    windowAfterEndMin: s.windowAfterEndMin,
  };
}

type Reader = Pick<
  TenantTx,
  | 'employee'
  | 'tenantSettings'
  | 'branch'
  | 'shiftAssignment'
  | 'shift'
  | 'attendancePolicy'
  | 'weeklyOffPattern'
  | 'holiday'
  | 'employeeDayOverride'
  | 'leaveRequest'
  | 'leaveType'
  | 'attendanceManualMark'
  | 'regularizationRequest'
  | 'punch'
  | 'tenantFeature'
>;

/** Loads everything needed to compute an employee's days over a date range in a few queries. */
@Injectable()
export class DayInputsLoader {
  constructor(
    private readonly db: DbService,
    private readonly cache: CacheService,
  ) {}

  async load(employeeId: string, from: IsoDate, to: IsoDate, reader?: Reader): Promise<EmployeeContext | null> {
    const db = reader ?? this.db.tenant;
    const employee = await db.employee.findUnique({ where: { id: employeeId } });
    if (!employee) return null;
    const [timezone, settings, branch, assignments, overtime] = await Promise.all([
      this.cache.remember(`tz:${employee.tenantId}`, TZ_CACHE_SEC, async () => {
        const tenant = await this.db.platform.tenant.findUniqueOrThrow({ where: { id: employee.tenantId }, select: { timezone: true } });
        return tenant.timezone;
      }),
      db.tenantSettings.findUnique({ where: { tenantId: employee.tenantId } }),
      db.branch.findUniqueOrThrow({ where: { id: employee.branchId } }),
      db.shiftAssignment.findMany({
        where: { employeeId, effectiveFrom: { lte: toDbDate(to) }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: toDbDate(from) } }] },
        include: { shift: true },
        orderBy: { effectiveFrom: 'asc' },
      }),
      db.tenantFeature.findUnique({ where: { tenantId_key: { tenantId: employee.tenantId, key: 'OVERTIME' } } }),
    ]);
    // Working hours: employee assignment > branch default > company default; a disabled shift falls through.
    const defaultIds = [branch.defaultShiftId, settings?.defaultShiftId].filter((v): v is string => !!v);
    const defaults = defaultIds.length > 0 ? await db.shift.findMany({ where: { id: { in: defaultIds }, active: true } }) : [];
    const defaultShift = defaultIds.map((id) => defaults.find((s) => s.id === id)).find((s) => s !== undefined) ?? null;
    const policyIds = new Set<string>(
      [employee.policyId, settings?.defaultPolicyId, defaultShift?.policyId, ...assignments.map((a) => a.shift.policyId)].filter(
        (v): v is string => !!v,
      ),
    );
    const patternId = employee.weeklyOffPatternId ?? branch.weeklyOffPatternId ?? settings?.defaultPatternId ?? null;
    const calendarId = branch.holidayCalendarId ?? settings?.defaultCalendarId ?? null;
    const range = { gte: toDbDate(from), lte: toDbDate(to) };
    const [policies, pattern, holidays, overrides, leaves, marks, regularizations, punches] = await Promise.all([
      db.attendancePolicy.findMany({ where: { id: { in: [...policyIds] } } }),
      patternId ? db.weeklyOffPattern.findUnique({ where: { id: patternId } }) : Promise.resolve(null),
      calendarId ? db.holiday.findMany({ where: { calendarId, holidayDate: range } }) : Promise.resolve([]),
      db.employeeDayOverride.findMany({ where: { employeeId, revokedAt: null, overrideDate: range } }),
      db.leaveRequest.findMany({
        where: { employeeId, status: 'APPROVED', fromDate: { lte: toDbDate(to) }, toDate: { gte: toDbDate(from) } },
      }),
      db.attendanceManualMark.findMany({ where: { employeeId, attendanceDate: range }, orderBy: { createdAt: 'desc' } }),
      db.regularizationRequest.findMany({
        where: { employeeId, attendanceDate: range, liveKey: { not: null } },
        select: { id: true, attendanceDate: true, status: true, approvedMinutes: true },
      }),
      db.punch.findMany({
        where: { employeeId, attendanceDate: range, voidedAt: null },
        select: { attendanceDate: true, serverTime: true },
        orderBy: { serverTime: 'asc' },
      }),
    ]);
    const leaveTypes = await db.leaveType.findMany({
      where: { id: { in: [...new Set([...leaves.map((l) => l.leaveTypeId), ...marks.map((m) => m.leaveTypeId).filter((v): v is string => !!v)])] } },
    });
    const paidType = new Map(leaveTypes.map((t) => [t.id, t.isPaid]));
    const countsNonWorking = new Map(leaveTypes.map((t) => [t.id, t.countNonWorkingDays]));
    const policyById = new Map(policies.map((p) => [p.id, p]));
    const rules = (pattern?.active ? (pattern.rules as WeeklyOffRule[]) : []) ?? [];

    const days = new Map<IsoDate, DayInputs>();
    for (const date of eachDate(from, to)) {
      const assignment = [...assignments].reverse().find((a) => {
        const start = dateOnly(a.effectiveFrom) as string;
        const end = dateOnly(a.effectiveTo);
        return start <= date && (!end || end >= date);
      });
      const shiftRow = (assignment?.shift.active ? assignment.shift : null) ?? defaultShift;
      const policyRow =
        (employee.policyId && policyById.get(employee.policyId)) ||
        (shiftRow?.policyId && policyById.get(shiftRow.policyId)) ||
        (settings?.defaultPolicyId && policyById.get(settings.defaultPolicyId)) ||
        null;
      const holiday = holidays.find((h) => dateOnly(h.holidayDate) === date);
      const override = overrides.find((o) => dateOnly(o.overrideDate) === date);
      const mark = marks.find((m) => dateOnly(m.attendanceDate) === date);
      const regularization = regularizations.find((r) => dateOnly(r.attendanceDate) === date);
      const leave = leaves.find((l) => (dateOnly(l.fromDate) as string) <= date && (dateOnly(l.toDate) as string) >= date);
      days.set(date, {
        date,
        shift: shiftRow ? toShift(shiftRow) : null,
        policy: toPolicy(policyRow),
        weeklyOffRules: rules,
        holiday: holiday ? { id: holiday.id, name: holiday.name, isPaid: holiday.isPaid } : null,
        override: override ? { id: override.id, allowPunch: override.allowPunch } : null,
        leave: leave
          ? this.leaveFor(leave, date, paidType.get(leave.leaveTypeId) ?? true, countsNonWorking.get(leave.leaveTypeId) ?? false)
          : null,
        manualMark:
          mark && mark.action === 'SET' && mark.status
            ? { id: mark.id, status: mark.status, leaveTypeId: mark.leaveTypeId, leavePaid: mark.leaveTypeId ? (paidType.get(mark.leaveTypeId) ?? true) : true }
            : null,
        regularization:
          regularization && regularization.status !== 'CANCELLED'
            ? { id: regularization.id, status: regularization.status, approvedMinutes: regularization.approvedMinutes }
            : null,
        punchTimes: punches.filter((p) => dateOnly(p.attendanceDate) === date).map((p) => p.serverTime),
      });
    }
    return {
      employeeId,
      tenantId: employee.tenantId,
      timezone,
      branchId: employee.branchId,
      departmentId: employee.departmentId,
      dutyMinutesOverride: employee.dutyMinutes,
      joinDate: dateOnly(employee.dateOfJoining) as string,
      exitDate: dateOnly(employee.exitDate),
      overtimeEnabled: overtime?.enabled ?? false,
      days,
    };
  }

  private leaveFor(
    leave: { id: string; leaveTypeId: string; fromDate: Date; toDate: Date; fromPart: string; toPart: string },
    date: IsoDate,
    paid: boolean,
    countsNonWorking: boolean,
  ): DayInputs['leave'] {
    const from = dateOnly(leave.fromDate);
    const to = dateOnly(leave.toDate);
    const single = from === to;
    const half = single
      ? leave.fromPart !== 'FULL'
      : (date === from && leave.fromPart === 'SECOND_HALF') || (date === to && leave.toPart === 'FIRST_HALF');
    return { requestId: leave.id, leaveTypeId: leave.leaveTypeId, fraction: half ? 0.5 : 1, paid, countsNonWorking };
  }
}
