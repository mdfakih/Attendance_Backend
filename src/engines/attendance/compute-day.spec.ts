import { describe, expect, it } from 'vitest';
import { computeDay, type ComputeDayInput, computeWorked, type DayPolicy } from './compute-day.js';

const policy: DayPolicy = {
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
};

const at = (hhmm: string) => new Date(`2026-11-02T${hhmm}:00.000Z`);

function input(overrides: Partial<ComputeDayInput> = {}): ComputeDayInput {
  return {
    dayType: 'WORKING',
    holidayPaid: true,
    punchTimes: [],
    expectedStartAt: at('09:00'),
    expectedEndAt: at('18:00'),
    dutyMinutes: 480,
    unpaidBreakMinutes: 60,
    isFlexible: false,
    policy,
    overtimeEnabled: false,
    leave: null,
    manualMark: null,
    otDecision: null,
    isFinal: true,
    ...overrides,
  };
}

describe('computeWorked', () => {
  it('FILO uses first and last punch minus unpaid break', () => {
    expect(computeWorked([at('09:00'), at('13:00'), at('14:00'), at('18:00')], 'FIRST_IN_LAST_OUT', 60)).toEqual({
      minutes: 480,
      missingOut: false,
    });
  });

  it('FILO single punch is a missing out-punch with zero hours', () => {
    expect(computeWorked([at('09:00')], 'FIRST_IN_LAST_OUT', 60)).toEqual({ minutes: 0, missingOut: true });
  });

  it('sum of pairs adds closed pairs and ignores a dangling punch', () => {
    expect(computeWorked([at('09:00'), at('13:00'), at('14:00'), at('17:00'), at('17:30')], 'SUM_OF_PAIRS', 60)).toEqual({
      minutes: 420,
      missingOut: true,
    });
  });
});

describe('computeDay status and fractions', () => {
  it('full day present when worked ≥ duty', () => {
    const day = computeDay(input({ punchTimes: [at('09:00'), at('18:00')] }));
    expect(day.finalStatus).toBe('PRESENT');
    expect(day.workedMinutes).toBe(480);
    expect([day.paidFraction, day.lopFraction]).toEqual([1, 0]);
  });

  it('half day between half-day threshold and duty', () => {
    const day = computeDay(input({ punchTimes: [at('09:00'), at('14:30')] }));
    expect(day.finalStatus).toBe('HALF_DAY');
    expect([day.paidFraction, day.lopFraction]).toEqual([0.5, 0.5]);
  });

  it('short hours become absent with a flag', () => {
    const day = computeDay(input({ punchTimes: [at('09:00'), at('11:00')] }));
    expect(day.finalStatus).toBe('ABSENT');
    expect(day.flags).toContain('SHORT_HOURS');
  });

  it('no punches on a finalized working day is absent; before final it is not started', () => {
    expect(computeDay(input()).finalStatus).toBe('ABSENT');
    expect(computeDay(input({ isFinal: false })).finalStatus).toBe('NOT_STARTED');
  });

  it('open day with punches is in progress and has no pay fractions yet', () => {
    const day = computeDay(input({ punchTimes: [at('09:00')], isFinal: false }));
    expect(day.finalStatus).toBe('IN_PROGRESS');
    expect([day.paidFraction, day.lopFraction]).toEqual([0, 0]);
    expect(day.isMissingOut).toBe(false);
  });

  it('missing out-punch follows the tenant treatment', () => {
    const single = [at('09:00')];
    expect(computeDay(input({ punchTimes: single })).finalStatus).toBe('ABSENT');
    const half = computeDay(input({ punchTimes: single, policy: { ...policy, missingOutTreatment: 'HALF_DAY' } }));
    expect(half.finalStatus).toBe('HALF_DAY');
    expect(half.isMissingOut).toBe(true);
    expect(half.flags).toContain('MISSING_OUT');
  });

  it('marks late beyond grace and early leave', () => {
    const day = computeDay(input({ punchTimes: [at('09:25'), at('17:30')] }));
    expect(day.isLate).toBe(true);
    expect(day.lateMinutes).toBe(25);
    expect(day.earlyLeaveMinutes).toBe(30);
  });

  it('within grace is not late', () => {
    expect(computeDay(input({ punchTimes: [at('09:08'), at('18:00')] })).isLate).toBe(false);
  });

  it('holidays and weekly offs are paid; unpaid holiday is LOP', () => {
    expect(computeDay(input({ dayType: 'HOLIDAY' })).paidFraction).toBe(1);
    expect(computeDay(input({ dayType: 'WEEKLY_OFF' })).finalStatus).toBe('WEEKLY_OFF');
    expect(computeDay(input({ dayType: 'HOLIDAY', holidayPaid: false })).lopFraction).toBe(1);
  });

  it('work on an off day is flagged', () => {
    const day = computeDay(input({ dayType: 'WEEKLY_OFF', punchTimes: [at('10:00'), at('14:00')] }));
    expect(day.finalStatus).toBe('WEEKLY_OFF');
    expect(day.flags).toContain('WORKED_ON_OFF_DAY');
  });

  it('full-day paid and unpaid leave', () => {
    expect(computeDay(input({ leave: { fraction: 1, paid: true } })).paidFraction).toBe(1);
    const unpaid = computeDay(input({ leave: { fraction: 1, paid: false } }));
    expect(unpaid.finalStatus).toBe('LEAVE');
    expect(unpaid.lopFraction).toBe(1);
  });

  it('half-day leave combines with the worked half', () => {
    const worked = computeDay(input({ leave: { fraction: 0.5, paid: true }, punchTimes: [at('13:00'), at('18:00')] }));
    expect(worked.finalStatus).toBe('HALF_LEAVE');
    expect([worked.paidFraction, worked.lopFraction]).toEqual([1, 0]);
    const notWorked = computeDay(input({ leave: { fraction: 0.5, paid: true } }));
    expect([notWorked.paidFraction, notWorked.lopFraction]).toEqual([0.5, 0.5]);
  });

  it('manual mark overrides the computed status', () => {
    const day = computeDay(input({ manualMark: { status: 'PRESENT', leavePaid: true } }));
    expect(day.computedStatus).toBe('ABSENT');
    expect(day.finalStatus).toBe('PRESENT');
    expect(day.statusSource).toBe('MANUAL');
    expect(day.paidFraction).toBe(1);
  });
});

describe('overtime', () => {
  const long = [at('09:00'), at('20:10')];

  it('is ignored when the feature is off', () => {
    expect(computeDay(input({ punchTimes: long })).otMinutes).toBe(0);
  });

  it('rounds down, caps, and waits for approval', () => {
    const day = computeDay(input({ punchTimes: long, overtimeEnabled: true }));
    expect(day.workedMinutes).toBe(610);
    expect(day.otMinutes).toBe(120);
    expect(day.otState).toBe('PENDING');
    expect(day.otApprovedMinutes).toBe(0);
  });

  it('is auto-approved when approval is not required', () => {
    const day = computeDay(input({ punchTimes: long, overtimeEnabled: true, policy: { ...policy, otRequiresApproval: false } }));
    expect(day.otState).toBe('APPROVED');
    expect(day.otApprovedMinutes).toBe(120);
  });

  it('keeps an employer decision, clamped to computed minutes', () => {
    const day = computeDay(
      input({ punchTimes: long, overtimeEnabled: true, otDecision: { state: 'APPROVED', approvedMinutes: 500 } }),
    );
    expect(day.otApprovedMinutes).toBe(120);
  });

  it('below the minimum is not overtime', () => {
    const day = computeDay(input({ punchTimes: [at('09:00'), at('18:20')], overtimeEnabled: true }));
    expect(day.otMinutes).toBe(0);
  });
});
