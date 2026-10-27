import type { DayType } from '@attendance/contracts';
import { describe, expect, it } from 'vitest';
import { eachDate, dayOfWeek } from '../time/dates.js';
import { computeEarnedPay, type PayDay, type PayInput } from './earned-pay.js';

const START = '2026-11-01';
const END = '2026-11-30';

/** Sundays off; every other day PRESENT unless listed. */
function month(overrides: Readonly<Record<string, Partial<PayDay>>> = {}): { calendar: Map<string, DayType>; days: PayDay[] } {
  const calendar = new Map<string, DayType>();
  const days = eachDate(START, END).map((date): PayDay => {
    const dayType: DayType = dayOfWeek(date) === 0 ? 'WEEKLY_OFF' : 'WORKING';
    calendar.set(date, dayType);
    const base: PayDay = {
      date,
      dayType,
      finalStatus: dayType === 'WORKING' ? 'PRESENT' : 'WEEKLY_OFF',
      paidFraction: 1,
      lopFraction: 0,
      leaveFraction: 0,
      leavePaid: true,
      holidayPaid: true,
      workedMinutes: dayType === 'WORKING' ? 480 : 0,
      otApprovedMinutes: 0,
      isFinalized: true,
    };
    return { ...base, ...overrides[date] };
  });
  return { calendar, days };
}

const absent: Partial<PayDay> = { finalStatus: 'ABSENT', paidFraction: 0, lopFraction: 1, workedMinutes: 0 };

function input(overrides: Partial<PayInput> = {}): PayInput {
  const { calendar, days } = month();
  return {
    periodStart: START,
    periodEnd: END,
    joinDate: '2025-01-01',
    exitDate: null,
    calendar,
    days,
    salary: [{ from: '2025-01-01', to: null, basis: 'MONTHLY', amount: '30000', otMultiplier: null }],
    divisorMode: 'CALENDAR',
    overtimeEnabled: false,
    defaultOtMultiplier: '1.5',
    dutyMinutes: 480,
    adjustments: [],
    asOf: END,
    roundNet: true,
    ...overrides,
  };
}

describe('computeEarnedPay — monthly basis', () => {
  it('pays the full salary for a fully present month', () => {
    const r = computeEarnedPay(input());
    expect(r.netEarned).toBe('30000.00');
    expect(r.payableDays).toBe('30.00');
    expect(r.presentDays).toBe('25.00');
    expect(r.weeklyOffDays).toBe('5.00');
    expect(r.projectedNet).toBeNull();
  });

  it('deducts LOP days at salary ÷ calendar days', () => {
    const { calendar, days } = month({ '2026-11-02': absent, '2026-11-03': absent });
    const r = computeEarnedPay(input({ calendar, days }));
    expect(r.lopDays).toBe('2.00');
    expect(r.payableDays).toBe('28.00');
    expect(r.netEarned).toBe('28000.00');
    expect(r.absentDays).toBe('2.00');
  });

  it('supports a fixed 26-day divisor', () => {
    const { calendar, days } = month({ '2026-11-02': absent, '2026-11-03': absent });
    const r = computeEarnedPay(input({ calendar, days, divisorMode: 'FIXED_26', roundNet: false }));
    expect(r.payableDays).toBe('24.00');
    expect(r.netEarned).toBe('27692.31');
  });

  it('supports a working-days divisor', () => {
    const { calendar, days } = month({ '2026-11-02': absent });
    const r = computeEarnedPay(input({ calendar, days, divisorMode: 'WORKING_DAYS', roundNet: false }));
    expect(r.divisor).toBe('25.00');
    expect(r.payableDays).toBe('24.00');
    expect(r.netEarned).toBe('28800.00');
  });

  it('prorates a mid-month joiner', () => {
    const r = computeEarnedPay(input({ joinDate: '2026-11-16' }));
    expect(r.employedDays).toBe('15.00');
    expect(r.netEarned).toBe('15000.00');
  });

  it('splits a mid-month salary revision into segments', () => {
    const r = computeEarnedPay(
      input({
        salary: [
          { from: '2025-01-01', to: '2026-11-15', basis: 'MONTHLY', amount: '30000', otMultiplier: null },
          { from: '2026-11-16', to: null, basis: 'MONTHLY', amount: '36000', otMultiplier: null },
        ],
      }),
    );
    expect(r.segments).toHaveLength(2);
    expect(r.netEarned).toBe('33000.00');
  });

  it('applies manual additions and deductions', () => {
    const r = computeEarnedPay(
      input({
        adjustments: [
          { direction: 'ADDITION', amount: '1500' },
          { direction: 'DEDUCTION', amount: '500.50' },
        ],
        roundNet: false,
      }),
    );
    expect(r.additions).toBe('1500.00');
    expect(r.deductions).toBe('500.50');
    expect(r.netEarned).toBe('30999.50');
  });

  it('reports month-to-date and projected pay for an open month', () => {
    const { calendar, days } = month({ '2026-11-03': absent });
    const r = computeEarnedPay(input({ calendar, days, asOf: '2026-11-15' }));
    expect(r.mtdThrough).toBe('2026-11-15');
    expect(r.netEarned).toBe('14000.00');
    expect(r.projectedNet).toBe('29000.00');
  });

  it('pays monthly overtime at the hourly equivalent × multiplier', () => {
    const { calendar, days } = month({ '2026-11-02': { otApprovedMinutes: 120 } });
    const r = computeEarnedPay(input({ calendar, days, overtimeEnabled: true, roundNet: false }));
    // day rate 1000, hourly 125, 2h × 125 × 1.5
    expect(r.otEarned).toBe('375.00');
    expect(r.netEarned).toBe('30375.00');
  });

  it('flags missing salary and negative net', () => {
    expect(computeEarnedPay(input({ salary: [] })).flags).toContain('NO_SALARY');
    const negative = computeEarnedPay(input({ adjustments: [{ direction: 'DEDUCTION', amount: '40000' }] }));
    expect(negative.flags).toContain('NEGATIVE_NET');
  });

  it('ignores provisional days and flags them', () => {
    const { calendar, days } = month({ '2026-11-02': { ...absent, isFinalized: false } });
    const r = computeEarnedPay(input({ calendar, days }));
    expect(r.lopDays).toBe('0.00');
    expect(r.flags).toContain('UNFINALIZED_DAYS');
  });
});

describe('computeEarnedPay — hourly and weekly bases', () => {
  it('pays hourly employees for worked hours only', () => {
    const r = computeEarnedPay(
      input({ salary: [{ from: '2025-01-01', to: null, basis: 'HOURLY', amount: '200', otMultiplier: null }] }),
    );
    // 25 working days × 8 h × ₹200
    expect(r.netEarned).toBe('40000.00');
    expect(r.workedMinutes).toBe(12000);
  });

  it('pays hourly overtime with a multiplier when enabled', () => {
    const { calendar, days } = month({ '2026-11-02': { workedMinutes: 600, otApprovedMinutes: 120 } });
    const r = computeEarnedPay(
      input({
        calendar,
        days,
        overtimeEnabled: true,
        salary: [{ from: '2025-01-01', to: null, basis: 'HOURLY', amount: '200', otMultiplier: '2' }],
      }),
    );
    expect(r.otEarned).toBe('800.00');
    expect(r.netEarned).toBe('40800.00');
  });

  it('turns a weekly rate into a day rate (calendar divisor = 7)', () => {
    const r = computeEarnedPay(
      input({ salary: [{ from: '2025-01-01', to: null, basis: 'WEEKLY', amount: '7000', otMultiplier: null }] }),
    );
    expect(r.netEarned).toBe('30000.00');
  });
});
