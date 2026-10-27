import type { DayType, WeeklyOffRule } from '@attendance/contracts';
import { dayOfWeek, type IsoDate, weekOfMonth } from '../time/dates.js';

export function isWeeklyOff(date: IsoDate, rules: readonly WeeklyOffRule[]): boolean {
  const dow = dayOfWeek(date);
  const week = weekOfMonth(date);
  return rules.some((rule) => rule.dow === dow && (rule.weeks === 'ALL' || rule.weeks.includes(week)));
}

export interface HolidayRef {
  readonly id: string;
  readonly name: string;
  readonly isPaid: boolean;
}

export interface DayClassification {
  readonly dayType: DayType;
  readonly holiday: HolidayRef | null;
}

/** Holiday wins over weekly off; everything else is a working day. */
export function classifyDay(date: IsoDate, holiday: HolidayRef | null, weeklyOffRules: readonly WeeklyOffRule[]): DayClassification {
  if (holiday) {
    return { dayType: 'HOLIDAY', holiday };
  }
  return { dayType: isWeeklyOff(date, weeklyOffRules) ? 'WEEKLY_OFF' : 'WORKING', holiday: null };
}

export type PunchGate =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: 'NON_WORKING_DAY' | 'ON_LEAVE' };

/** Override (allow punch) > full-day approved leave > holiday/weekly off > working. */
export function punchGate(dayType: DayType, fullDayLeave: boolean, overrideAllowsPunch: boolean): PunchGate {
  if (overrideAllowsPunch) {
    return { allowed: true };
  }
  if (fullDayLeave) {
    return { allowed: false, reason: 'ON_LEAVE' };
  }
  if (dayType !== 'WORKING') {
    return { allowed: false, reason: 'NON_WORKING_DAY' };
  }
  return { allowed: true };
}
