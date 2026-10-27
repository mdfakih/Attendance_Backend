import type { DayType } from '@attendance/contracts';
import { describe, expect, it } from 'vitest';
import { dayOfWeek } from '../time/dates.js';
import { isValidSpan, leaveFractions, totalLeaveDays } from './leave-days.js';

const sundaysOff = (date: string): DayType => (dayOfWeek(date) === 0 ? 'WEEKLY_OFF' : 'WORKING');

describe('leaveFractions', () => {
  it('counts a single full day as 1 and a half day as 0.5', () => {
    expect(totalLeaveDays(leaveFractions({ fromDate: '2026-11-02', fromPart: 'FULL', toDate: '2026-11-02', toPart: 'FULL' }, sundaysOff, false))).toBe(1);
    expect(
      totalLeaveDays(
        leaveFractions({ fromDate: '2026-11-02', fromPart: 'FIRST_HALF', toDate: '2026-11-02', toPart: 'FIRST_HALF' }, sundaysOff, false),
      ),
    ).toBe(0.5);
  });

  it('skips weekly offs unless configured to count them', () => {
    const span = { fromDate: '2026-10-31', fromPart: 'FULL', toDate: '2026-11-02', toPart: 'FULL' } as const;
    expect(totalLeaveDays(leaveFractions(span, sundaysOff, false))).toBe(2);
    expect(totalLeaveDays(leaveFractions(span, sundaysOff, true))).toBe(3);
  });

  it('applies half days at the edges of a multi-day span', () => {
    const span = { fromDate: '2026-11-02', fromPart: 'SECOND_HALF', toDate: '2026-11-04', toPart: 'FIRST_HALF' } as const;
    const fractions = leaveFractions(span, sundaysOff, false);
    expect(fractions.get('2026-11-02')).toBe(0.5);
    expect(fractions.get('2026-11-03')).toBe(1);
    expect(fractions.get('2026-11-04')).toBe(0.5);
    expect(totalLeaveDays(fractions)).toBe(2);
  });
});

describe('isValidSpan', () => {
  it('rejects reversed ranges and halves when not allowed', () => {
    expect(isValidSpan({ fromDate: '2026-11-03', fromPart: 'FULL', toDate: '2026-11-02', toPart: 'FULL' }, true)).toBe(false);
    expect(isValidSpan({ fromDate: '2026-11-02', fromPart: 'FIRST_HALF', toDate: '2026-11-02', toPart: 'FIRST_HALF' }, false)).toBe(false);
  });

  it('rejects a multi-day span that starts in the first half or ends in the second half', () => {
    expect(isValidSpan({ fromDate: '2026-11-02', fromPart: 'FIRST_HALF', toDate: '2026-11-03', toPart: 'FULL' }, true)).toBe(false);
    expect(isValidSpan({ fromDate: '2026-11-02', fromPart: 'SECOND_HALF', toDate: '2026-11-03', toPart: 'FIRST_HALF' }, true)).toBe(true);
  });
});
