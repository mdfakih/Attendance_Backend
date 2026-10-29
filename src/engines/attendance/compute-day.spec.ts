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
  outsideMinMinutes: 15,
};

const at = (hhmm: string) => new Date(`2026-11-02T${hhmm}:00.000Z`);
const window = { startAt: at('09:00'), endAt: at('18:00') };

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
    regularization: null,
    isFinal: true,
    ...overrides,
  };
}

describe('computeWorked', () => {
  it('FILO uses first and last punch minus unpaid break', () => {
    expect(computeWorked([at('09:00'), at('13:00'), at('14:00'), at('18:00')], 'FIRST_IN_LAST_OUT', 60, window)).toEqual({
      insideMinutes: 480,
      earlyMinutes: 0,
      lateMinutes: 0,
      missingOut: false,
      closed: true,
    });
  });

  it('FILO single punch is a missing out-punch with zero hours', () => {
    expect(computeWorked([at('09:00')], 'FIRST_IN_LAST_OUT', 60, window)).toEqual({
      insideMinutes: 0,
      earlyMinutes: 0,
      lateMinutes: 0,
      missingOut: true,
      closed: false,
    });
  });

  it('FILO ends at the last OUT; a trailing IN leaves the day open', () => {
    expect(computeWorked([at('09:00'), at('13:00'), at('14:00')], 'FIRST_IN_LAST_OUT', 60, window)).toEqual({
      insideMinutes: 180,
      earlyMinutes: 0,
      lateMinutes: 0,
      missingOut: true,
      closed: true,
    });
  });

  it('splits time before the start and after the end out of working hours', () => {
    expect(computeWorked([at('08:00'), at('20:00')], 'FIRST_IN_LAST_OUT', 60, window)).toEqual({
      insideMinutes: 480,
      earlyMinutes: 60,
      lateMinutes: 120,
      missingOut: false,
      closed: true,
    });
  });

  it('sum of pairs clips each pair, adds closed pairs and ignores a dangling punch', () => {
    expect(computeWorked([at('08:30'), at('13:00'), at('14:00'), at('18:30'), at('19:00')], 'SUM_OF_PAIRS', 60, window)).toEqual({
      insideMinutes: 480,
      earlyMinutes: 30,
      lateMinutes: 30,
      missingOut: true,
      closed: true,
    });
  });

  it('counts everything as inside when there are no fixed hours', () => {
    expect(computeWorked([at('07:00'), at('20:00')], 'FIRST_IN_LAST_OUT', 60, null)).toEqual({
      insideMinutes: 720,
      earlyMinutes: 0,
      lateMinutes: 0,
      missingOut: false,
      closed: true,
    });
  });
});

describe('computeDay status and fractions', () => {
  it('full day present when worked ≥ duty', () => {
    const day = computeDay(input({ punchTimes: [at('09:00'), at('18:00')] }));
    expect(day.finalStatus).toBe('PRESENT');
    expect(day.workedMinutes).toBe(480);
    expect(day.outsideMinutes).toBe(0);
    expect(day.regState).toBe('NOT_APPLICABLE');
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

  it('a trailing IN after a closed session is classified by hours, not the missing-out treatment', () => {
    const day = computeDay(input({ punchTimes: [at('09:00'), at('14:00'), at('15:00')] }));
    expect(day.workedMinutes).toBe(240);
    expect(day.finalStatus).toBe('HALF_DAY');
    expect(day.isMissingOut).toBe(true);
    expect(day.flags).toContain('MISSING_OUT');
  });

  it('marks late beyond grace and early leave', () => {
    const day = computeDay(input({ punchTimes: [at('09:25'), at('17:30')] }));
    expect(day.isLate).toBe(true);
    expect(day.lateMinutes).toBe(25);
    expect(day.earlyLeaveMinutes).toBe(30);
  });

  it('within grace is not late; arriving early is not late', () => {
    expect(computeDay(input({ punchTimes: [at('09:08'), at('18:00')] })).isLate).toBe(false);
    expect(computeDay(input({ punchTimes: [at('08:00'), at('18:00')] })).isLate).toBe(false);
  });

  it('holidays and weekly offs are paid; unpaid holiday is LOP', () => {
    expect(computeDay(input({ dayType: 'HOLIDAY' })).paidFraction).toBe(1);
    expect(computeDay(input({ dayType: 'WEEKLY_OFF' })).finalStatus).toBe('WEEKLY_OFF');
    expect(computeDay(input({ dayType: 'HOLIDAY', holidayPaid: false })).lopFraction).toBe(1);
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

describe('working hours', () => {
  it('records time outside working hours but does not count it', () => {
    const day = computeDay(input({ punchTimes: [at('08:00'), at('20:00')] }));
    expect(day.workedMinutes).toBe(480);
    expect(day.outsideEarlyMinutes).toBe(60);
    expect(day.outsideLateMinutes).toBe(120);
    expect(day.outsideMinutes).toBe(180);
    expect(day.regState).toBe('AVAILABLE');
    expect(day.flags).toContain('OUTSIDE_HOURS');
    expect(day.finalStatus).toBe('PRESENT');
  });

  it('a late arrival is not made up by staying late until the employer accepts it', () => {
    const day = computeDay(input({ punchTimes: [at('10:00'), at('19:00')] }));
    expect(day.workedMinutes).toBe(420);
    expect(day.outsideLateMinutes).toBe(60);
    expect(day.finalStatus).toBe('HALF_DAY');
  });

  it('punches entirely after hours count nothing', () => {
    const day = computeDay(input({ punchTimes: [at('19:00'), at('21:00')] }));
    expect(day.workedMinutes).toBe(0);
    expect(day.outsideMinutes).toBe(120);
    expect(day.finalStatus).toBe('ABSENT');
  });

  it('ignores outside time below the threshold on each side', () => {
    const day = computeDay(input({ punchTimes: [at('08:46'), at('18:14')] }));
    expect(day.outsideMinutes).toBe(0);
    expect(day.regState).toBe('NOT_APPLICABLE');
    expect(day.flags).not.toContain('OUTSIDE_HOURS');
  });

  it('keeps one side when only that side reaches the threshold', () => {
    const day = computeDay(input({ punchTimes: [at('08:50'), at('18:30')] }));
    expect(day.outsideEarlyMinutes).toBe(0);
    expect(day.outsideLateMinutes).toBe(30);
    expect(day.outsideMinutes).toBe(30);
  });

  it('flexible shifts and days without a shift count all time', () => {
    const flexible = computeDay(input({ isFlexible: true, punchTimes: [at('07:00'), at('20:00')] }));
    expect(flexible.workedMinutes).toBe(720);
    expect(flexible.outsideMinutes).toBe(0);
    const noShift = computeDay(input({ expectedStartAt: null, expectedEndAt: null, punchTimes: [at('07:00'), at('20:00')] }));
    expect(noShift.workedMinutes).toBe(720);
  });

  it('all time on an off day is outside working hours', () => {
    const day = computeDay(input({ dayType: 'WEEKLY_OFF', punchTimes: [at('10:00'), at('14:00')] }));
    expect(day.finalStatus).toBe('WEEKLY_OFF');
    expect(day.flags).toContain('WORKED_ON_OFF_DAY');
    expect(day.workedMinutes).toBe(0);
    expect(day.outsideMinutes).toBe(180);
    expect(day.regState).toBe('NOT_APPLICABLE');
  });

  it('off-day time can be requested only when overtime is on', () => {
    const day = computeDay(input({ dayType: 'WEEKLY_OFF', overtimeEnabled: true, punchTimes: [at('10:00'), at('14:00')] }));
    expect(day.regState).toBe('AVAILABLE');
  });
});

describe('regularization', () => {
  const long = [at('08:00'), at('20:00')];

  it('a pending request does not count yet', () => {
    const day = computeDay(input({ punchTimes: long, regularization: { status: 'PENDING', approvedMinutes: 0 } }));
    expect(day.regState).toBe('REQUESTED');
    expect(day.workedMinutes).toBe(480);
    expect(day.regApprovedMinutes).toBe(0);
  });

  it('approved minutes are added, clamped to the outside time', () => {
    const partial = computeDay(input({ punchTimes: long, regularization: { status: 'APPROVED', approvedMinutes: 30 } }));
    expect(partial.regState).toBe('APPROVED');
    expect(partial.workedMinutes).toBe(510);
    const tooMany = computeDay(input({ punchTimes: long, regularization: { status: 'APPROVED', approvedMinutes: 999 } }));
    expect(tooMany.regApprovedMinutes).toBe(180);
    expect(tooMany.workedMinutes).toBe(660);
  });

  it('a rejected request counts nothing', () => {
    const day = computeDay(input({ punchTimes: long, regularization: { status: 'REJECTED', approvedMinutes: 0 } }));
    expect(day.regState).toBe('REJECTED');
    expect(day.workedMinutes).toBe(480);
  });

  it('approved time first fills the shortfall up to a full day', () => {
    const day = computeDay(input({ punchTimes: [at('10:00'), at('19:00')], regularization: { status: 'APPROVED', approvedMinutes: 60 } }));
    expect(day.workedMinutes).toBe(480);
    expect(day.finalStatus).toBe('PRESENT');
    expect(day.otMinutes).toBe(0);
  });

  it('is auto-approved when the policy does not require approval', () => {
    const day = computeDay(input({ punchTimes: long, policy: { ...policy, otRequiresApproval: false } }));
    expect(day.regState).toBe('APPROVED');
    expect(day.regApprovedMinutes).toBe(180);
    expect(day.workedMinutes).toBe(660);
  });
});

describe('overtime', () => {
  const long = [at('08:00'), at('20:00')];
  const approvedAll = { status: 'APPROVED' as const, approvedMinutes: 999 };

  it('is ignored when the feature is off', () => {
    expect(computeDay(input({ punchTimes: long, regularization: approvedAll })).otMinutes).toBe(0);
  });

  it('never comes from time the employer has not approved', () => {
    const day = computeDay(input({ punchTimes: long, overtimeEnabled: true }));
    expect(day.otMinutes).toBe(0);
    expect(day.otState).toBe('NOT_APPLICABLE');
  });

  it('is the approved time beyond a full day, rounded and capped', () => {
    const day = computeDay(input({ punchTimes: [at('08:00'), at('20:10')], overtimeEnabled: true, regularization: approvedAll }));
    expect(day.workedMinutes).toBe(670);
    expect(day.otMinutes).toBe(180);
    expect(day.otState).toBe('APPROVED');
    expect(day.otApprovedMinutes).toBe(180);
  });

  it('fills the shortfall first and only the rest is overtime', () => {
    const day = computeDay(input({ punchTimes: [at('10:00'), at('20:00')], overtimeEnabled: true, regularization: approvedAll }));
    expect(day.workedMinutes).toBe(540);
    expect(day.otMinutes).toBe(60);
  });

  it('below the minimum is not overtime', () => {
    const day = computeDay(input({ punchTimes: [at('09:00'), at('18:20')], overtimeEnabled: true, regularization: approvedAll }));
    expect(day.otMinutes).toBe(0);
  });

  it('approved off-day time is overtime', () => {
    const day = computeDay(
      input({ dayType: 'WEEKLY_OFF', overtimeEnabled: true, punchTimes: [at('10:00'), at('14:00')], regularization: approvedAll }),
    );
    expect(day.otMinutes).toBe(180);
    expect(day.finalStatus).toBe('WEEKLY_OFF');
  });
});
