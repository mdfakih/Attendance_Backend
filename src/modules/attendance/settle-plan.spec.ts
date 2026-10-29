import { describe, expect, it } from 'vitest';
import { isDayDue, planSettle, type StoredDayState } from './settle-plan.js';

const now = new Date('2026-11-05T12:00:00Z');
const V = 'att-2';

function row(date: string, overrides: Partial<StoredDayState> = {}): StoredDayState {
  return {
    date,
    isFinalized: true,
    windowEndAt: new Date(`${date}T23:59:00Z`),
    needsRecompute: false,
    engineVersion: V,
    periodLocked: false,
    ...overrides,
  };
}

describe('isDayDue', () => {
  it('a missing day is due', () => {
    expect(isDayDue(undefined, now, V)).toBe(true);
  });

  it('a final, current day is not due', () => {
    expect(isDayDue(row('2026-11-03'), now, V)).toBe(false);
  });

  it('an open day whose window has closed is due', () => {
    expect(isDayDue(row('2026-11-04', { isFinalized: false, windowEndAt: new Date('2026-11-05T02:00:00Z') }), now, V)).toBe(true);
  });

  it('an open day still inside its window is not due', () => {
    expect(isDayDue(row('2026-11-05', { isFinalized: false, windowEndAt: new Date('2026-11-06T00:00:00Z') }), now, V)).toBe(false);
  });

  it('flagged days and days from an older engine are due', () => {
    expect(isDayDue(row('2026-11-03', { needsRecompute: true }), now, V)).toBe(true);
    expect(isDayDue(row('2026-11-03', { engineVersion: 'att-1' }), now, V)).toBe(true);
  });

  it('a day in a locked pay period is never due', () => {
    expect(isDayDue(row('2026-11-03', { needsRecompute: true, periodLocked: true }), now, V)).toBe(false);
  });
});

describe('planSettle', () => {
  const base = { from: '2026-11-01', to: '2026-11-05', lockedMonths: new Set<string>(), now, engineVersion: V };
  const allDays = ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05'];

  it('skips employees whose days are all current', () => {
    const rows = new Map([['e1', allDays.map((d) => row(d))]]);
    expect(planSettle({ ...base, employees: [{ id: 'e1', joinDate: '2026-01-01', exitDate: null }], rows })).toEqual([]);
  });

  it('covers the due days of each employee with one range', () => {
    const rows = new Map([['e1', allDays.filter((d) => d !== '2026-11-02' && d !== '2026-11-04').map((d) => row(d))]]);
    expect(planSettle({ ...base, employees: [{ id: 'e1', joinDate: '2026-01-01', exitDate: null }], rows })).toEqual([
      { employeeId: 'e1', from: '2026-11-02', to: '2026-11-04' },
    ]);
  });

  it('clamps to the join and exit dates', () => {
    const plan = planSettle({ ...base, employees: [{ id: 'e1', joinDate: '2026-11-03', exitDate: '2026-11-04' }], rows: new Map() });
    expect(plan).toEqual([{ employeeId: 'e1', from: '2026-11-03', to: '2026-11-04' }]);
  });

  it('ignores employees outside the range and days in locked months', () => {
    const plan = planSettle({
      ...base,
      lockedMonths: new Set(['2026-11']),
      employees: [
        { id: 'e1', joinDate: '2026-01-01', exitDate: null },
        { id: 'e2', joinDate: '2026-12-01', exitDate: null },
      ],
      rows: new Map(),
    });
    expect(plan).toEqual([]);
  });
});
