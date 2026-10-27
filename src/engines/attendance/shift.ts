import { addDays, type IsoDate, localDateOf, localTimeToUtc, startOfLocalDay } from '../time/dates.js';

export interface ShiftDefinition {
  readonly startTime: string;
  readonly endTime: string;
  readonly dutyMinutes: number;
  readonly unpaidBreakMinutes: number;
  readonly isFlexible: boolean;
  readonly windowBeforeStartMin: number;
  readonly windowAfterEndMin: number;
}

export interface ShiftInstance {
  readonly date: IsoDate;
  readonly startAt: Date;
  readonly endAt: Date;
  readonly windowStartAt: Date;
  readonly windowEndAt: Date;
  readonly implicit: boolean;
}

const MINUTE = 60_000;

export function isOvernight(shift: Pick<ShiftDefinition, 'startTime' | 'endTime'>): boolean {
  return shift.endTime <= shift.startTime;
}

/** Concrete UTC times of a shift on a business date. `null` shift = implicit local calendar day. */
export function shiftInstance(date: IsoDate, shift: ShiftDefinition | null, timezone: string): ShiftInstance {
  if (!shift) {
    const startAt = startOfLocalDay(date, timezone);
    const endAt = startOfLocalDay(addDays(date, 1), timezone);
    return { date, startAt, endAt, windowStartAt: startAt, windowEndAt: endAt, implicit: true };
  }
  const startAt = localTimeToUtc(date, shift.startTime, timezone);
  const endDate = isOvernight(shift) ? addDays(date, 1) : date;
  const endAt = localTimeToUtc(endDate, shift.endTime, timezone);
  return {
    date,
    startAt,
    endAt,
    windowStartAt: new Date(startAt.getTime() - shift.windowBeforeStartMin * MINUTE),
    windowEndAt: new Date(endAt.getTime() + shift.windowAfterEndMin * MINUTE),
    implicit: false,
  };
}

export interface Attribution {
  readonly date: IsoDate;
  readonly instance: ShiftInstance;
  readonly outOfWindow: boolean;
}

/**
 * Picks the business date a punch belongs to. Candidates are the previous and the current
 * local date; the instance whose window contains the punch wins (latest start on overlap).
 * Example: a 05:50 Tuesday punch on a 22:00–06:00 shift belongs to Monday.
 */
export function attributePunch(
  at: Date,
  timezone: string,
  shiftFor: (date: IsoDate) => ShiftDefinition | null,
): Attribution {
  const today = localDateOf(at, timezone);
  const candidates = [addDays(today, -1), today]
    .map((date) => shiftInstance(date, shiftFor(date), timezone))
    .filter((inst) => inst.windowStartAt <= at && at < inst.windowEndAt)
    .filter((inst) => !(inst.implicit && inst.date !== today))
    .sort((a, b) => b.startAt.getTime() - a.startAt.getTime());
  const hit = candidates.find((inst) => inst.startAt <= at) ?? candidates[0];
  if (hit) {
    return { date: hit.date, instance: hit, outOfWindow: false };
  }
  return { date: today, instance: shiftInstance(today, shiftFor(today), timezone), outOfWindow: true };
}
