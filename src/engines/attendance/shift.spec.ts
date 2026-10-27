import { describe, expect, it } from 'vitest';
import { classifyDay, isWeeklyOff, punchGate } from './calendar.js';
import { attributePunch, type ShiftDefinition, shiftInstance } from './shift.js';

const TZ = 'Asia/Kolkata';
const general: ShiftDefinition = {
  startTime: '09:00',
  endTime: '18:00',
  dutyMinutes: 480,
  unpaidBreakMinutes: 60,
  isFlexible: false,
  windowBeforeStartMin: 120,
  windowAfterEndMin: 360,
};
const night: ShiftDefinition = { ...general, startTime: '22:00', endTime: '06:00' };

describe('shiftInstance', () => {
  it('converts local shift times to UTC (IST = UTC+5:30)', () => {
    const inst = shiftInstance('2026-11-02', general, TZ);
    expect(inst.startAt.toISOString()).toBe('2026-11-02T03:30:00.000Z');
    expect(inst.endAt.toISOString()).toBe('2026-11-02T12:30:00.000Z');
  });

  it('ends on the next day for overnight shifts', () => {
    const inst = shiftInstance('2026-11-02', night, TZ);
    expect(inst.endAt.toISOString()).toBe('2026-11-03T00:30:00.000Z');
  });

  it('uses the local calendar day when no shift applies', () => {
    const inst = shiftInstance('2026-11-02', null, TZ);
    expect(inst.startAt.toISOString()).toBe('2026-11-01T18:30:00.000Z');
    expect(inst.implicit).toBe(true);
  });
});

describe('attributePunch', () => {
  it('assigns an early-morning punch on a night shift to the previous day', () => {
    const punch = new Date('2026-11-03T00:20:00.000Z'); // 05:50 IST Tuesday
    expect(attributePunch(punch, TZ, () => night).date).toBe('2026-11-02');
  });

  it('assigns a day-shift punch to the same day', () => {
    const punch = new Date('2026-11-02T03:35:00.000Z'); // 09:05 IST
    expect(attributePunch(punch, TZ, () => general).date).toBe('2026-11-02');
  });

  it('uses the local date with no shift, even just after midnight IST', () => {
    const punch = new Date('2026-11-02T18:40:00.000Z'); // 00:10 IST on the 3rd
    expect(attributePunch(punch, TZ, () => null).date).toBe('2026-11-03');
  });

  it('flags punches outside every window', () => {
    const strict: ShiftDefinition = { ...general, windowBeforeStartMin: 0, windowAfterEndMin: 0 };
    const punch = new Date('2026-11-02T16:00:00.000Z'); // 21:30 IST
    const result = attributePunch(punch, TZ, () => strict);
    expect(result.outOfWindow).toBe(true);
    expect(result.date).toBe('2026-11-02');
  });
});

describe('calendar', () => {
  it('matches weekly offs by weekday and week of month', () => {
    const rules = [
      { dow: 0, weeks: 'ALL' as const },
      { dow: 6, weeks: [2, 4] },
    ];
    expect(isWeeklyOff('2026-11-01', rules)).toBe(true); // Sunday
    expect(isWeeklyOff('2026-11-07', rules)).toBe(false); // 1st Saturday
    expect(isWeeklyOff('2026-11-14', rules)).toBe(true); // 2nd Saturday
    expect(isWeeklyOff('2026-11-02', rules)).toBe(false); // Monday
  });

  it('holiday wins over weekly off', () => {
    const holiday = { id: 'h', name: 'Diwali', isPaid: true };
    expect(classifyDay('2026-11-01', holiday, [{ dow: 0, weeks: 'ALL' }]).dayType).toBe('HOLIDAY');
  });

  it('gates punching: override > leave > non-working > working', () => {
    expect(punchGate('HOLIDAY', false, false)).toEqual({ allowed: false, reason: 'NON_WORKING_DAY' });
    expect(punchGate('HOLIDAY', false, true)).toEqual({ allowed: true });
    expect(punchGate('WORKING', true, false)).toEqual({ allowed: false, reason: 'ON_LEAVE' });
    expect(punchGate('WORKING', false, false)).toEqual({ allowed: true });
  });
});
