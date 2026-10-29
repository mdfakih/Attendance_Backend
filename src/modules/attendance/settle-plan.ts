import { eachDate, type IsoDate, maxDate, minDate, monthOf } from '../../engines/time/dates.js';

/** The stored fields that decide whether a day must be recomputed before it is read. */
export interface StoredDayState {
  readonly date: IsoDate;
  readonly isFinalized: boolean;
  readonly windowEndAt: Date | null;
  readonly needsRecompute: boolean;
  readonly engineVersion: string;
  readonly periodLocked: boolean;
}

export interface SettleEmployee {
  readonly id: string;
  readonly joinDate: IsoDate;
  readonly exitDate: IsoDate | null;
}

export interface SettleTask {
  readonly employeeId: string;
  readonly from: IsoDate;
  readonly to: IsoDate;
}

/**
 * A day is due when it was never written (e.g. no punches, so nothing triggered it), its attribution
 * window closed while it was still open, a bulk change flagged it, or an older engine wrote it.
 */
export function isDayDue(row: StoredDayState | undefined, now: Date, engineVersion: string): boolean {
  if (!row) return true;
  if (row.periodLocked) return false;
  if (row.needsRecompute || row.engineVersion !== engineVersion) return true;
  return !row.isFinalized && !!row.windowEndAt && row.windowEndAt <= now;
}

/** Pure: one recompute range per employee spanning that employee's due days. */
export function planSettle(args: {
  readonly employees: readonly SettleEmployee[];
  readonly rows: ReadonlyMap<string, readonly StoredDayState[]>;
  readonly from: IsoDate;
  readonly to: IsoDate;
  readonly lockedMonths: ReadonlySet<string>;
  readonly now: Date;
  readonly engineVersion: string;
}): SettleTask[] {
  const tasks: SettleTask[] = [];
  for (const employee of args.employees) {
    const start = maxDate(args.from, employee.joinDate);
    const end = employee.exitDate ? minDate(args.to, employee.exitDate) : args.to;
    if (start > end) continue;
    const byDate = new Map((args.rows.get(employee.id) ?? []).map((r) => [r.date, r]));
    const due = eachDate(start, end).filter((date) => !args.lockedMonths.has(monthOf(date)) && isDayDue(byDate.get(date), args.now, args.engineVersion));
    if (due.length > 0) {
      tasks.push({ employeeId: employee.id, from: due[0], to: due[due.length - 1] });
    }
  }
  return tasks;
}
