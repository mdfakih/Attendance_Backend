import { fromDbDate } from '../engines/time/dates.js';

interface DecimalLike {
  toFixed(dp?: number): string;
}

/** Decimal → "1234.50" (null-safe). */
export function money(value: DecimalLike | null | undefined): string | null {
  return value === null || value === undefined ? null : value.toFixed(2);
}

export function num(value: DecimalLike | null | undefined): number | null {
  return value === null || value === undefined ? null : Number(value.toFixed(2));
}

/** `@db.Date` → "YYYY-MM-DD" (null-safe). */
export function dateOnly(value: Date | null | undefined): string | null {
  return value ? fromDbDate(value) : null;
}

export function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

export function pageMeta(page: number, pageSize: number, total: number) {
  return { page, pageSize, total };
}
