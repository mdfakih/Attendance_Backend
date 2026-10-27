import type { AttendanceStatus, DayType, HoursMode, ManualMarkStatus, MissingOutTreatment } from '@attendance/contracts';
import { minutesBetween } from '../time/dates.js';

export const ATTENDANCE_ENGINE_VERSION = 'att-1';

export type OtState = 'NOT_APPLICABLE' | 'PENDING' | 'APPROVED' | 'REJECTED';

export interface DayPolicy {
  readonly hoursMode: HoursMode;
  readonly lateGraceMin: number;
  readonly earlyLeaveGraceMin: number;
  readonly fullDayMinMinutes: number | null;
  readonly halfDayMinMinutes: number;
  readonly missingOutTreatment: MissingOutTreatment;
  readonly otMinMinutes: number;
  readonly otRoundingMinutes: number;
  readonly otDailyCapMinutes: number;
  readonly otRequiresApproval: boolean;
}

export interface ComputeDayInput {
  readonly dayType: DayType;
  readonly holidayPaid: boolean;
  /** Non-voided punch server times, ascending. */
  readonly punchTimes: readonly Date[];
  /** Null for flexible shifts or when no shift applies. */
  readonly expectedStartAt: Date | null;
  readonly expectedEndAt: Date | null;
  readonly dutyMinutes: number;
  readonly unpaidBreakMinutes: number;
  readonly isFlexible: boolean;
  readonly policy: DayPolicy;
  readonly overtimeEnabled: boolean;
  readonly leave: { readonly fraction: 0.5 | 1; readonly paid: boolean } | null;
  readonly manualMark: { readonly status: ManualMarkStatus; readonly leavePaid: boolean } | null;
  readonly otDecision: { readonly state: 'APPROVED' | 'REJECTED'; readonly approvedMinutes: number } | null;
  /** True once the attribution window has closed: the day can no longer change by punching. */
  readonly isFinal: boolean;
}

export interface DayResult {
  readonly punchCount: number;
  readonly firstPunchAt: Date | null;
  readonly lastPunchAt: Date | null;
  readonly workedMinutes: number;
  readonly lateMinutes: number;
  readonly earlyLeaveMinutes: number;
  readonly isLate: boolean;
  readonly isMissingOut: boolean;
  readonly otMinutes: number;
  readonly otState: OtState;
  readonly otApprovedMinutes: number;
  readonly computedStatus: AttendanceStatus;
  readonly finalStatus: AttendanceStatus;
  readonly statusSource: 'COMPUTED' | 'MANUAL';
  readonly paidFraction: number;
  readonly lopFraction: number;
  readonly leaveFraction: number;
  readonly flags: readonly string[];
}

interface Worked {
  readonly minutes: number;
  readonly missingOut: boolean;
}

export function computeWorked(times: readonly Date[], mode: HoursMode, unpaidBreakMinutes: number): Worked {
  if (times.length === 0) {
    return { minutes: 0, missingOut: false };
  }
  if (mode === 'FIRST_IN_LAST_OUT') {
    if (times.length === 1) {
      return { minutes: 0, missingOut: true };
    }
    const span = minutesBetween(times[0], times[times.length - 1]);
    return { minutes: span > unpaidBreakMinutes ? span - unpaidBreakMinutes : span, missingOut: false };
  }
  let minutes = 0;
  for (let i = 0; i + 1 < times.length; i += 2) {
    minutes += minutesBetween(times[i], times[i + 1]);
  }
  return { minutes, missingOut: times.length % 2 === 1 };
}

function classifyByWorked(worked: number, fullDayMin: number, halfDayMin: number): AttendanceStatus {
  if (worked >= fullDayMin) return 'PRESENT';
  if (worked >= halfDayMin) return 'HALF_DAY';
  return 'ABSENT';
}

const MISSING_OUT_STATUS: Readonly<Record<MissingOutTreatment, AttendanceStatus>> = {
  ABSENT: 'ABSENT',
  HALF_DAY: 'HALF_DAY',
  PRESENT_FLAGGED: 'PRESENT',
};

function computeStatus(input: ComputeDayInput, worked: Worked): AttendanceStatus {
  const { leave, dayType, punchTimes, isFinal, policy } = input;
  const halfLeave = leave?.fraction === 0.5;
  if (leave?.fraction === 1) return 'LEAVE';
  if (dayType === 'HOLIDAY') return 'HOLIDAY';
  if (dayType === 'WEEKLY_OFF') return 'WEEKLY_OFF';
  if (punchTimes.length === 0) {
    if (halfLeave) return 'HALF_LEAVE';
    return isFinal ? 'ABSENT' : 'NOT_STARTED';
  }
  if (!isFinal) return halfLeave ? 'HALF_LEAVE' : 'IN_PROGRESS';
  if (halfLeave) return 'HALF_LEAVE';
  if (worked.missingOut && policy.hoursMode === 'FIRST_IN_LAST_OUT') {
    return MISSING_OUT_STATUS[policy.missingOutTreatment];
  }
  const fullDayMin = policy.fullDayMinMinutes ?? input.dutyMinutes;
  return classifyByWorked(worked.minutes, fullDayMin, policy.halfDayMinMinutes);
}

interface Fractions {
  readonly paid: number;
  readonly lop: number;
}

function fractionsFor(
  status: AttendanceStatus,
  opts: { leavePaid: boolean; holidayPaid: boolean; workedMinutes: number; halfDayMin: number },
): Fractions {
  switch (status) {
    case 'PRESENT':
    case 'WEEKLY_OFF':
      return { paid: 1, lop: 0 };
    case 'HALF_DAY':
      return { paid: 0.5, lop: 0.5 };
    case 'ABSENT':
      return { paid: 0, lop: 1 };
    case 'LEAVE':
      return opts.leavePaid ? { paid: 1, lop: 0 } : { paid: 0, lop: 1 };
    case 'HOLIDAY':
      return opts.holidayPaid ? { paid: 1, lop: 0 } : { paid: 0, lop: 1 };
    case 'HALF_LEAVE': {
      const leavePart = opts.leavePaid ? { paid: 0.5, lop: 0 } : { paid: 0, lop: 0.5 };
      const workPart = opts.workedMinutes >= opts.halfDayMin ? { paid: 0.5, lop: 0 } : { paid: 0, lop: 0.5 };
      return { paid: leavePart.paid + workPart.paid, lop: leavePart.lop + workPart.lop };
    }
    default:
      return { paid: 0, lop: 0 };
  }
}

interface Overtime {
  readonly minutes: number;
  readonly state: OtState;
  readonly approved: number;
}

function computeOvertime(input: ComputeDayInput, worked: Worked): Overtime {
  const none: Overtime = { minutes: 0, state: 'NOT_APPLICABLE', approved: 0 };
  if (!input.overtimeEnabled || worked.minutes === 0) {
    return none;
  }
  const { policy } = input;
  const beyond = input.dayType === 'WORKING' ? worked.minutes - input.dutyMinutes : worked.minutes;
  if (beyond < policy.otMinMinutes || beyond <= 0) {
    return none;
  }
  const rounded = Math.floor(beyond / policy.otRoundingMinutes) * policy.otRoundingMinutes;
  const minutes = Math.min(rounded, policy.otDailyCapMinutes);
  if (minutes <= 0) return none;
  if (!input.isFinal) return { minutes, state: 'NOT_APPLICABLE', approved: 0 };
  if (input.otDecision) {
    const approved = input.otDecision.state === 'APPROVED' ? Math.min(input.otDecision.approvedMinutes, minutes) : 0;
    return { minutes, state: input.otDecision.state, approved };
  }
  return policy.otRequiresApproval
    ? { minutes, state: 'PENDING', approved: 0 }
    : { minutes, state: 'APPROVED', approved: minutes };
}

function lateness(input: ComputeDayInput, worked: Worked): { late: number; early: number } {
  const { punchTimes, policy } = input;
  if (input.isFlexible || input.dayType !== 'WORKING' || punchTimes.length === 0) {
    return { late: 0, early: 0 };
  }
  const first = punchTimes[0];
  const last = punchTimes[punchTimes.length - 1];
  const rawLate = input.expectedStartAt ? minutesBetween(input.expectedStartAt, first) : 0;
  const closed = punchTimes.length >= 2 && !worked.missingOut;
  const rawEarly = closed && input.expectedEndAt && input.isFinal ? minutesBetween(last, input.expectedEndAt) : 0;
  return {
    late: rawLate > policy.lateGraceMin ? rawLate : 0,
    early: rawEarly > policy.earlyLeaveGraceMin ? rawEarly : 0,
  };
}

/** Pure: derives one employee-day from punches, calendar, leave, manual mark and policy. */
export function computeDay(input: ComputeDayInput): DayResult {
  const { punchTimes, policy } = input;
  const worked = computeWorked(punchTimes, policy.hoursMode, input.unpaidBreakMinutes);
  const computedStatus = computeStatus(input, worked);
  const finalStatus: AttendanceStatus = input.manualMark?.status ?? computedStatus;
  const leavePaid = input.manualMark ? input.manualMark.leavePaid : (input.leave?.paid ?? true);
  const { paid, lop } = fractionsFor(finalStatus, {
    leavePaid,
    holidayPaid: input.holidayPaid,
    workedMinutes: worked.minutes,
    halfDayMin: policy.halfDayMinMinutes,
  });
  const { late, early } = lateness(input, worked);
  const ot = computeOvertime(input, worked);
  const isMissingOut = worked.missingOut && input.isFinal;

  const flags = [
    isMissingOut ? 'MISSING_OUT' : null,
    late > 0 ? 'LATE' : null,
    early > 0 ? 'EARLY_LEAVE' : null,
    input.dayType !== 'WORKING' && punchTimes.length > 0 ? 'WORKED_ON_OFF_DAY' : null,
    input.isFinal && computedStatus === 'ABSENT' && punchTimes.length > 0 && !isMissingOut ? 'SHORT_HOURS' : null,
    input.manualMark ? 'MANUAL' : null,
  ].filter((f): f is string => f !== null);

  return {
    punchCount: punchTimes.length,
    firstPunchAt: punchTimes[0] ?? null,
    lastPunchAt: punchTimes[punchTimes.length - 1] ?? null,
    workedMinutes: worked.minutes,
    lateMinutes: late,
    earlyLeaveMinutes: early,
    isLate: late > 0,
    isMissingOut,
    otMinutes: ot.minutes,
    otState: ot.state,
    otApprovedMinutes: ot.approved,
    computedStatus,
    finalStatus,
    statusSource: input.manualMark ? 'MANUAL' : 'COMPUTED',
    paidFraction: paid,
    lopFraction: lop,
    leaveFraction: finalStatus === 'LEAVE' ? 1 : (input.leave?.fraction ?? 0),
    flags,
  };
}
