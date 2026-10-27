import type { DayType, PayableDaysBasis, SalaryBasis } from '@attendance/contracts';
import { Decimal } from 'decimal.js';
import { diffDays, eachDate, type IsoDate, maxDate, minDate } from '../time/dates.js';

export const PAY_ENGINE_VERSION = 'pay-1';

export interface PayDay {
  readonly date: IsoDate;
  readonly dayType: DayType;
  readonly finalStatus: string;
  readonly paidFraction: number;
  readonly lopFraction: number;
  readonly leaveFraction: number;
  readonly leavePaid: boolean;
  readonly holidayPaid: boolean;
  readonly workedMinutes: number;
  readonly otApprovedMinutes: number;
  readonly isFinalized: boolean;
}

export interface SalarySegmentInput {
  readonly from: IsoDate;
  readonly to: IsoDate | null;
  readonly basis: SalaryBasis;
  readonly amount: string;
  readonly otMultiplier: string | null;
}

export interface PayAdjustmentInput {
  readonly direction: 'ADDITION' | 'DEDUCTION';
  readonly amount: string;
}

export interface PayInput {
  readonly periodStart: IsoDate;
  readonly periodEnd: IsoDate;
  readonly joinDate: IsoDate;
  readonly exitDate: IsoDate | null;
  /** Day type for every date in the period (from calendar), used for WORKING_DAYS divisors. */
  readonly calendar: ReadonlyMap<IsoDate, DayType>;
  /** Attendance days that exist (finalized or provisional). */
  readonly days: readonly PayDay[];
  readonly salary: readonly SalarySegmentInput[];
  readonly divisorMode: PayableDaysBasis;
  readonly overtimeEnabled: boolean;
  readonly defaultOtMultiplier: string;
  readonly dutyMinutes: number;
  readonly adjustments: readonly PayAdjustmentInput[];
  /** Last date counted for month-to-date (tenant-local "today" or period end). */
  readonly asOf: IsoDate;
  readonly roundNet: boolean;
}

export interface PaySegmentResult {
  readonly from: IsoDate;
  readonly to: IsoDate;
  readonly basis: SalaryBasis;
  readonly rate: string;
  readonly entitled: string;
  readonly lop: string;
  readonly payable: string;
  readonly base: string;
  readonly overtime: string;
}

export interface DayCounts {
  readonly presentDays: string;
  readonly halfDays: string;
  readonly paidHolidayDays: string;
  readonly weeklyOffDays: string;
  readonly paidLeaveDays: string;
  readonly unpaidLeaveDays: string;
  readonly absentDays: string;
}

export interface PayResult extends DayCounts {
  readonly salaryBasis: SalaryBasis | null;
  readonly rate: string | null;
  readonly divisor: string;
  readonly periodDays: number;
  readonly employedDays: string;
  readonly entitledDays: string;
  readonly lopDays: string;
  readonly payableDays: string;
  readonly workedMinutes: number;
  readonly otApprovedMinutes: number;
  readonly segments: readonly PaySegmentResult[];
  readonly baseEarned: string;
  readonly otEarned: string;
  readonly additions: string;
  readonly deductions: string;
  readonly netEarned: string;
  readonly projectedNet: string | null;
  readonly mtdThrough: IsoDate | null;
  readonly flags: readonly string[];
}

const ZERO = new Decimal(0);
const money = (d: Decimal): string => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
const qty = (d: Decimal): string => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);

function monthlyDivisor(mode: PayableDaysBasis, periodDays: number, workingDays: number): Decimal {
  switch (mode) {
    case 'FIXED_26':
      return new Decimal(26);
    case 'FIXED_30':
      return new Decimal(30);
    case 'WORKING_DAYS':
      return new Decimal(Math.max(workingDays, 1));
    default:
      return new Decimal(periodDays);
  }
}

/** Days-per-week equivalent used to turn a weekly rate into a day rate. */
function weeklyDivisor(mode: PayableDaysBasis, periodDays: number, workingDays: number): Decimal {
  switch (mode) {
    case 'FIXED_26':
      return new Decimal(6);
    case 'WORKING_DAYS':
      return new Decimal(Math.max(workingDays, 1)).mul(7).div(periodDays);
    default:
      return new Decimal(7);
  }
}

interface Window {
  readonly from: IsoDate;
  readonly to: IsoDate;
}

function clip(segment: SalarySegmentInput, bounds: Window): Window | null {
  const from = maxDate(segment.from, bounds.from);
  const to = minDate(segment.to ?? bounds.to, bounds.to);
  return from <= to ? { from, to } : null;
}

function inWindow(date: IsoDate, w: Window): boolean {
  return date >= w.from && date <= w.to;
}

function countDays(days: readonly PayDay[]): DayCounts {
  const sum = (pick: (d: PayDay) => number) => days.reduce((acc, d) => acc.plus(pick(d)), ZERO);
  return {
    presentDays: qty(sum((d) => (d.finalStatus === 'PRESENT' ? 1 : 0))),
    halfDays: qty(sum((d) => (d.finalStatus === 'HALF_DAY' ? 1 : 0))),
    paidHolidayDays: qty(sum((d) => (d.finalStatus === 'HOLIDAY' && d.holidayPaid ? 1 : 0))),
    weeklyOffDays: qty(sum((d) => (d.finalStatus === 'WEEKLY_OFF' ? 1 : 0))),
    paidLeaveDays: qty(sum((d) => (d.leavePaid ? d.leaveFraction : 0))),
    unpaidLeaveDays: qty(sum((d) => (d.leavePaid ? 0 : d.leaveFraction))),
    absentDays: qty(sum((d) => (d.finalStatus === 'ABSENT' ? 1 : 0))),
  };
}

interface SegmentCalc {
  readonly result: PaySegmentResult;
  readonly projectedBase: Decimal;
}

function computeSegment(
  segment: SalarySegmentInput,
  window: Window,
  input: PayInput,
  counted: readonly PayDay[],
  periodDays: number,
  workingDaysInPeriod: number,
): SegmentCalc {
  const rate = new Decimal(segment.amount);
  const segDays = counted.filter((d) => inWindow(d.date, window));
  const lop = segDays.reduce((acc, d) => acc.plus(d.lopFraction), ZERO);
  const worked = segDays.reduce((acc, d) => acc + d.workedMinutes, 0);
  const otMinutes = segDays.reduce((acc, d) => acc + d.otApprovedMinutes, 0);
  const multiplier = input.overtimeEnabled ? new Decimal(segment.otMultiplier ?? input.defaultOtMultiplier) : null;

  if (segment.basis === 'HOURLY') {
    const regular = new Decimal(worked - (multiplier ? otMinutes : 0)).div(60).mul(rate);
    const overtime = multiplier ? new Decimal(otMinutes).div(60).mul(rate).mul(multiplier) : ZERO;
    return {
      result: {
        from: window.from,
        to: window.to,
        basis: segment.basis,
        rate: money(rate),
        entitled: qty(ZERO),
        lop: qty(ZERO),
        payable: qty(ZERO),
        base: money(regular),
        overtime: money(overtime),
      },
      projectedBase: regular,
    };
  }

  const divisor =
    segment.basis === 'MONTHLY'
      ? monthlyDivisor(input.divisorMode, periodDays, workingDaysInPeriod)
      : weeklyDivisor(input.divisorMode, periodDays, workingDaysInPeriod);
  const dayRate = rate.div(divisor);
  const dates = eachDate(window.from, window.to);
  const elapsed = dates.filter((d) => d <= input.asOf);
  // Entitled days for a set of dates: the divisor spread evenly over the period, or the
  // working days themselves when the divisor is WORKING_DAYS.
  const share = (subset: readonly IsoDate[]): Decimal => {
    if (input.divisorMode === 'WORKING_DAYS') {
      return new Decimal(subset.filter((d) => input.calendar.get(d) === 'WORKING').length);
    }
    const perDay = segment.basis === 'MONTHLY' ? divisor.div(periodDays) : divisor.div(7);
    return perDay.mul(subset.length);
  };
  const entitledFull = share(dates);
  const entitledMtd = share(elapsed);
  const payable = Decimal.max(ZERO, Decimal.min(entitledMtd.minus(lop), entitledMtd));
  const payableProjected = Decimal.max(ZERO, Decimal.min(entitledFull.minus(lop), entitledFull));
  const base = dayRate.mul(payable);
  const hourlyEquivalent = input.dutyMinutes > 0 ? dayRate.div(input.dutyMinutes / 60) : ZERO;
  const overtime = multiplier ? new Decimal(otMinutes).div(60).mul(hourlyEquivalent).mul(multiplier) : ZERO;
  return {
    result: {
      from: window.from,
      to: window.to,
      basis: segment.basis,
      rate: money(rate),
      entitled: qty(entitledMtd),
      lop: qty(lop),
      payable: qty(payable),
      base: money(base),
      overtime: money(overtime),
    },
    projectedBase: dayRate.mul(payableProjected),
  };
}

/** Pure, deterministic earned-pay computation for one employee and one calendar month. */
export function computeEarnedPay(input: PayInput): PayResult {
  const periodDays = diffDays(input.periodStart, input.periodEnd) + 1;
  const employment: Window = {
    from: maxDate(input.joinDate, input.periodStart),
    to: minDate(input.exitDate ?? input.periodEnd, input.periodEnd),
  };
  const employed = employment.from <= employment.to;
  const asOf = minDate(input.asOf, input.periodEnd);
  const counted = input.days.filter((d) => d.isFinalized && d.date <= asOf && employed && inWindow(d.date, employment));
  const workingDaysInPeriod = [...input.calendar.values()].filter((t) => t === 'WORKING').length;

  const calcs = employed
    ? input.salary
        .map((segment) => ({ segment, window: clip(segment, employment) }))
        .filter((s): s is { segment: SalarySegmentInput; window: Window } => s.window !== null)
        .map(({ segment, window }) => computeSegment(segment, window, input, counted, periodDays, workingDaysInPeriod))
    : [];

  const sum = (pick: (r: PaySegmentResult) => string) => calcs.reduce((acc, c) => acc.plus(pick(c.result)), ZERO);
  const additions = input.adjustments
    .filter((a) => a.direction === 'ADDITION')
    .reduce((acc, a) => acc.plus(a.amount), ZERO);
  const deductions = input.adjustments
    .filter((a) => a.direction === 'DEDUCTION')
    .reduce((acc, a) => acc.plus(a.amount), ZERO);
  const base = sum((r) => r.base);
  const overtime = sum((r) => r.overtime);
  const rawNet = base.plus(overtime).plus(additions).minus(deductions);
  const net = input.roundNet ? rawNet.toDecimalPlaces(0, Decimal.ROUND_HALF_UP) : rawNet;
  const isPartial = asOf < input.periodEnd;
  const projectedRaw = calcs.reduce((acc, c) => acc.plus(c.projectedBase), ZERO).plus(overtime).plus(additions).minus(deductions);
  const projected = input.roundNet ? projectedRaw.toDecimalPlaces(0, Decimal.ROUND_HALF_UP) : projectedRaw;
  const latest = input.salary.length > 0 ? input.salary[input.salary.length - 1] : null;
  const unfinalized = input.days.some((d) => !d.isFinalized && d.date <= asOf);

  const flags = [
    input.salary.length === 0 ? 'NO_SALARY' : null,
    net.isNegative() ? 'NEGATIVE_NET' : null,
    unfinalized ? 'UNFINALIZED_DAYS' : null,
  ].filter((f): f is string => f !== null);

  const employedDays = employed ? diffDays(employment.from, employment.to) + 1 : 0;
  const firstBasis = latest?.basis ?? null;
  const divisor =
    firstBasis === 'WEEKLY'
      ? weeklyDivisor(input.divisorMode, periodDays, workingDaysInPeriod)
      : monthlyDivisor(input.divisorMode, periodDays, workingDaysInPeriod);

  return {
    ...countDays(counted),
    salaryBasis: firstBasis,
    rate: latest ? money(new Decimal(latest.amount)) : null,
    divisor: qty(divisor),
    periodDays,
    employedDays: qty(new Decimal(employedDays)),
    entitledDays: qty(sum((r) => r.entitled)),
    lopDays: qty(sum((r) => r.lop)),
    payableDays: qty(sum((r) => r.payable)),
    workedMinutes: counted.reduce((acc, d) => acc + d.workedMinutes, 0),
    otApprovedMinutes: counted.reduce((acc, d) => acc + d.otApprovedMinutes, 0),
    segments: calcs.map((c) => c.result),
    baseEarned: money(base),
    otEarned: money(overtime),
    additions: money(additions),
    deductions: money(deductions),
    netEarned: money(net),
    projectedNet: isPartial ? money(projected) : null,
    mtdThrough: isPartial ? asOf : null,
    flags,
  };
}
