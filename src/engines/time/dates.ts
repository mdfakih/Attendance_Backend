import { DateTime } from 'luxon';

/** Business dates are plain 'YYYY-MM-DD' strings; instants are JS Dates in UTC. */
export type IsoDate = string;

export function localDateOf(instant: Date, timezone: string): IsoDate {
  const iso = DateTime.fromJSDate(instant, { zone: timezone }).toISODate();
  if (!iso) {
    throw new Error(`Invalid instant or timezone: ${timezone}`);
  }
  return iso;
}

/** Converts a local wall-clock time on a date in `timezone` to a UTC instant. */
export function localTimeToUtc(date: IsoDate, hhmm: string, timezone: string): Date {
  const [hour, minute] = hhmm.split(':').map(Number);
  const local = DateTime.fromISO(date, { zone: timezone }).set({ hour, minute, second: 0, millisecond: 0 });
  if (!local.isValid) {
    throw new Error(`Invalid local time ${date} ${hhmm} ${timezone}`);
  }
  return local.toUTC().toJSDate();
}

export function startOfLocalDay(date: IsoDate, timezone: string): Date {
  return DateTime.fromISO(date, { zone: timezone }).startOf('day').toUTC().toJSDate();
}

export function addDays(date: IsoDate, days: number): IsoDate {
  return DateTime.fromISO(date, { zone: 'utc' }).plus({ days }).toISODate() as IsoDate;
}

export function diffDays(from: IsoDate, to: IsoDate): number {
  return Math.round(DateTime.fromISO(to, { zone: 'utc' }).diff(DateTime.fromISO(from, { zone: 'utc' }), 'days').days);
}

export function eachDate(from: IsoDate, to: IsoDate): IsoDate[] {
  const count = diffDays(from, to);
  return count < 0 ? [] : Array.from({ length: count + 1 }, (_, i) => addDays(from, i));
}

/** 0 = Sunday … 6 = Saturday. */
export function dayOfWeek(date: IsoDate): number {
  return DateTime.fromISO(date, { zone: 'utc' }).weekday % 7;
}

/** Nth occurrence of this weekday within its month (1–5). */
export function weekOfMonth(date: IsoDate): number {
  return Math.ceil(DateTime.fromISO(date, { zone: 'utc' }).day / 7);
}

export interface MonthRange {
  readonly start: IsoDate;
  readonly end: IsoDate;
  readonly days: number;
}

export function monthRange(month: string): MonthRange {
  const start = DateTime.fromISO(`${month}-01`, { zone: 'utc' });
  if (!start.isValid) {
    throw new Error(`Invalid month ${month}`);
  }
  const end = start.endOf('month');
  return { start: start.toISODate() as IsoDate, end: end.toISODate() as IsoDate, days: end.day };
}

export function monthOf(date: IsoDate): string {
  return date.slice(0, 7);
}

export function maxDate(a: IsoDate, b: IsoDate): IsoDate {
  return a >= b ? a : b;
}

export function minDate(a: IsoDate, b: IsoDate): IsoDate {
  return a <= b ? a : b;
}

/** Prisma maps `@db.Date` to a JS Date at UTC midnight. */
export function toDbDate(date: IsoDate): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

export function fromDbDate(value: Date): IsoDate {
  return value.toISOString().slice(0, 10);
}

export function minutesBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / 60000);
}
