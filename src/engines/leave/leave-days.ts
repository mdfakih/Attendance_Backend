import type { DayPart, DayType } from '@attendance/contracts';
import { eachDate, type IsoDate } from '../time/dates.js';

export interface LeaveSpan {
  readonly fromDate: IsoDate;
  readonly fromPart: DayPart;
  readonly toDate: IsoDate;
  readonly toPart: DayPart;
}

/**
 * Leave fraction per date. Single day: FULL = 1, half = 0.5. Multi-day: a start in the
 * SECOND_HALF and an end in the FIRST_HALF count 0.5. Non-working days count 0 unless
 * `countNonWorkingDays`.
 */
export function leaveFractions(
  span: LeaveSpan,
  dayTypeOf: (date: IsoDate) => DayType,
  countNonWorkingDays: boolean,
): ReadonlyMap<IsoDate, 0.5 | 1> {
  const dates = eachDate(span.fromDate, span.toDate);
  const entries = dates.flatMap((date): Array<[IsoDate, 0.5 | 1]> => {
    if (!countNonWorkingDays && dayTypeOf(date) !== 'WORKING') {
      return [];
    }
    const single = span.fromDate === span.toDate;
    const isHalf = single
      ? span.fromPart !== 'FULL'
      : (date === span.fromDate && span.fromPart === 'SECOND_HALF') || (date === span.toDate && span.toPart === 'FIRST_HALF');
    return [[date, isHalf ? 0.5 : 1]];
  });
  return new Map(entries);
}

export function totalLeaveDays(fractions: ReadonlyMap<IsoDate, 0.5 | 1>): number {
  return [...fractions.values()].reduce<number>((acc, f) => acc + f, 0);
}

export function isValidSpan(span: LeaveSpan, allowHalfDay: boolean): boolean {
  if (span.toDate < span.fromDate) return false;
  const usesHalf = span.fromPart !== 'FULL' || span.toPart !== 'FULL';
  if (usesHalf && !allowHalfDay) return false;
  if (span.fromDate === span.toDate) return span.fromPart === span.toPart || span.toPart === 'FULL';
  return span.fromPart !== 'FIRST_HALF' && span.toPart !== 'SECOND_HALF';
}
