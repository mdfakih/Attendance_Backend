import type { AttendanceStatus, DayType, HoursMode, ManualMarkStatus, MissingOutTreatment } from '@attendance/contracts';
import { minutesBetween } from '../time/dates.js';

export const ATTENDANCE_ENGINE_VERSION = 'att-2';

export type OtState = 'NOT_APPLICABLE' | 'PENDING' | 'APPROVED' | 'REJECTED';

/** Where a day stands on counting its outside-hours time. */
export type RegState = 'NOT_APPLICABLE' | 'AVAILABLE' | 'REQUESTED' | 'APPROVED' | 'REJECTED';

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
  /** When false, time outside working hours counts without an employer decision. */
  readonly otRequiresApproval: boolean;
  /** Outside time shorter than this, before the start or after the end, is ignored. */
  readonly outsideMinMinutes: number;
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
  /** The employee's live request to count outside-hours time, if any. */
  readonly regularization: { readonly status: 'PENDING' | 'APPROVED' | 'REJECTED'; readonly approvedMinutes: number } | null;
  /** True once the attribution window has closed: the day can no longer change by punching. */
  readonly isFinal: boolean;
}

export interface DayResult {
  readonly punchCount: number;
  readonly firstPunchAt: Date | null;
  readonly lastPunchAt: Date | null;
  /** Counted time: inside working hours plus approved outside time. */
  readonly workedMinutes: number;
  readonly outsideEarlyMinutes: number;
  readonly outsideLateMinutes: number;
  /** All outside time above the threshold. On an off day this is the whole worked time. */
  readonly outsideMinutes: number;
  readonly regState: RegState;
  readonly regApprovedMinutes: number;
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

export interface WorkWindow {
  readonly startAt: Date;
  readonly endAt: Date;
}

export interface Worked {
  /** Time within the window (all time when there is none), after the unpaid break in FILO mode. */
  readonly insideMinutes: number;
  /** Raw time before the window start; the threshold is applied by `computeDay`. */
  readonly earlyMinutes: number;
  /** Raw time after the window end. */
  readonly lateMinutes: number;
  /** The last session has an IN without an OUT. */
  readonly missingOut: boolean;
  /** At least one IN→OUT session was closed. */
  readonly closed: boolean;
}

type Session = readonly [Date, Date];

/** Punches alternate IN/OUT. FILO is one session from the first IN to the last OUT; pairs are each IN→OUT. */
function sessionsOf(times: readonly Date[], mode: HoursMode): Session[] {
  const closedCount = times.length - (times.length % 2);
  if (closedCount === 0) return [];
  if (mode === 'FIRST_IN_LAST_OUT') return [[times[0], times[closedCount - 1]]];
  const sessions: Session[] = [];
  for (let i = 0; i + 1 < closedCount; i += 2) {
    sessions.push([times[i], times[i + 1]]);
  }
  return sessions;
}

function overlap(from: Date, to: Date, rangeStart: number, rangeEnd: number): number {
  const start = Math.max(from.getTime(), rangeStart);
  const end = Math.min(to.getTime(), rangeEnd);
  return end > start ? minutesBetween(new Date(start), new Date(end)) : 0;
}

export function computeWorked(times: readonly Date[], mode: HoursMode, unpaidBreakMinutes: number, window: WorkWindow | null): Worked {
  const sessions = sessionsOf(times, mode);
  const start = window ? window.startAt.getTime() : -Infinity;
  const end = window ? window.endAt.getTime() : Infinity;
  let inside = 0;
  let early = 0;
  let late = 0;
  for (const [from, to] of sessions) {
    inside += overlap(from, to, start, end);
    early += overlap(from, to, -Infinity, start);
    late += overlap(from, to, end, Infinity);
  }
  if (mode === 'FIRST_IN_LAST_OUT' && inside > unpaidBreakMinutes) {
    inside -= unpaidBreakMinutes;
  }
  return { insideMinutes: inside, earlyMinutes: early, lateMinutes: late, missingOut: times.length % 2 === 1, closed: sessions.length > 0 };
}

interface Outside {
  readonly early: number;
  readonly late: number;
  readonly total: number;
}

function outsideTime(input: ComputeDayInput, worked: Worked): Outside {
  const min = input.policy.outsideMinMinutes;
  const keep = (minutes: number) => (minutes >= min ? minutes : 0);
  if (input.dayType !== 'WORKING') {
    return { early: 0, late: 0, total: keep(worked.insideMinutes) };
  }
  const early = keep(worked.earlyMinutes);
  const late = keep(worked.lateMinutes);
  return { early, late, total: early + late };
}

interface Regularization {
  readonly state: RegState;
  readonly approved: number;
}

const REG_STATE: Readonly<Record<'PENDING' | 'APPROVED' | 'REJECTED', RegState>> = {
  PENDING: 'REQUESTED',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
};

function regularize(input: ComputeDayInput, outside: Outside): Regularization {
  const eligible = outside.total > 0 && (input.dayType === 'WORKING' || input.overtimeEnabled);
  const request = input.regularization;
  if (request) {
    const approved = eligible && request.status === 'APPROVED' ? Math.min(request.approvedMinutes, outside.total) : 0;
    return { state: REG_STATE[request.status], approved };
  }
  if (!eligible) return { state: 'NOT_APPLICABLE', approved: 0 };
  return input.policy.otRequiresApproval ? { state: 'AVAILABLE', approved: 0 } : { state: 'APPROVED', approved: outside.total };
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

function computeStatus(input: ComputeDayInput, worked: Worked, counted: number): AttendanceStatus {
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
  if (worked.missingOut && !worked.closed && policy.hoursMode === 'FIRST_IN_LAST_OUT') {
    return MISSING_OUT_STATUS[policy.missingOutTreatment];
  }
  const fullDayMin = policy.fullDayMinMinutes ?? input.dutyMinutes;
  return classifyByWorked(counted, fullDayMin, policy.halfDayMinMinutes);
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

/** Only approved outside time can become overtime, and only the part beyond a full day of duty. */
function computeOvertime(input: ComputeDayInput, counted: number, approvedOutside: number): Overtime {
  const none: Overtime = { minutes: 0, state: 'NOT_APPLICABLE', approved: 0 };
  if (!input.overtimeEnabled || approvedOutside === 0) {
    return none;
  }
  const { policy } = input;
  const beyond = input.dayType === 'WORKING' ? Math.min(approvedOutside, counted - input.dutyMinutes) : approvedOutside;
  if (beyond < policy.otMinMinutes || beyond <= 0) {
    return none;
  }
  const rounded = Math.floor(beyond / policy.otRoundingMinutes) * policy.otRoundingMinutes;
  const minutes = Math.min(rounded, policy.otDailyCapMinutes);
  return minutes > 0 ? { minutes, state: 'APPROVED', approved: minutes } : none;
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

function workWindow(input: ComputeDayInput): WorkWindow | null {
  if (input.dayType !== 'WORKING' || input.isFlexible || !input.expectedStartAt || !input.expectedEndAt) {
    return null;
  }
  return { startAt: input.expectedStartAt, endAt: input.expectedEndAt };
}

/** Pure: derives one employee-day from punches, calendar, leave, manual mark, regularization and policy. */
export function computeDay(input: ComputeDayInput): DayResult {
  const { punchTimes, policy } = input;
  const worked = computeWorked(punchTimes, policy.hoursMode, input.unpaidBreakMinutes, workWindow(input));
  const outside = outsideTime(input, worked);
  const reg = regularize(input, outside);
  const inside = input.dayType === 'WORKING' ? worked.insideMinutes : 0;
  const counted = inside + reg.approved;
  const computedStatus = computeStatus(input, worked, counted);
  const finalStatus: AttendanceStatus = input.manualMark?.status ?? computedStatus;
  const leavePaid = input.manualMark ? input.manualMark.leavePaid : (input.leave?.paid ?? true);
  const { paid, lop } = fractionsFor(finalStatus, {
    leavePaid,
    holidayPaid: input.holidayPaid,
    workedMinutes: counted,
    halfDayMin: policy.halfDayMinMinutes,
  });
  const { late, early } = lateness(input, worked);
  const ot = computeOvertime(input, counted, reg.approved);
  const isMissingOut = worked.missingOut && input.isFinal;

  const flags = [
    isMissingOut ? 'MISSING_OUT' : null,
    late > 0 ? 'LATE' : null,
    early > 0 ? 'EARLY_LEAVE' : null,
    input.dayType !== 'WORKING' && punchTimes.length > 0 ? 'WORKED_ON_OFF_DAY' : null,
    input.isFinal && computedStatus === 'ABSENT' && punchTimes.length > 0 && !isMissingOut ? 'SHORT_HOURS' : null,
    outside.total > 0 && reg.state !== 'NOT_APPLICABLE' ? 'OUTSIDE_HOURS' : null,
    input.manualMark ? 'MANUAL' : null,
  ].filter((f): f is string => f !== null);

  return {
    punchCount: punchTimes.length,
    firstPunchAt: punchTimes[0] ?? null,
    lastPunchAt: punchTimes[punchTimes.length - 1] ?? null,
    workedMinutes: counted,
    outsideEarlyMinutes: outside.early,
    outsideLateMinutes: outside.late,
    outsideMinutes: outside.total,
    regState: reg.state,
    regApprovedMinutes: reg.approved,
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
