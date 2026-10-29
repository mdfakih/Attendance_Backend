import { Injectable, Logger } from '@nestjs/common';
import { requireTenantId } from '../../core/context/request-context.js';
import { DbService } from '../../core/database/db.service.js';
import { CacheService } from '../../core/redis/cache.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { forEachLimit } from '../../common/concurrency.js';
import { dateOnly } from '../../common/serialize.js';
import { ATTENDANCE_ENGINE_VERSION } from '../../engines/attendance/compute-day.js';
import { type IsoDate, localDateOf, minDate, monthOf, toDbDate } from '../../engines/time/dates.js';
import { AttendanceDayService } from './attendance-day.service.js';
import { planSettle, type StoredDayState } from './settle-plan.js';

const CONCURRENCY = 8;
const TZ_CACHE_SEC = 300;

/**
 * Brings stored attendance days up to date right before they are read, which replaces the
 * scheduled jobs: absent days get created, days whose window closed get finalized, and days
 * flagged by bulk changes get recomputed. Idempotent and cheap when nothing is due.
 */
@Injectable()
export class AttendanceSettleService {
  private readonly logger = new Logger(AttendanceSettleService.name);

  constructor(
    private readonly db: DbService,
    private readonly cache: CacheService,
    private readonly days: AttendanceDayService,
  ) {}

  async today(): Promise<IsoDate> {
    const tenantId = requireTenantId();
    const timezone = await this.cache.remember(`tz:${tenantId}`, TZ_CACHE_SEC, async () => {
      const tenant = await this.db.platform.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { timezone: true } });
      return tenant.timezone;
    });
    return localDateOf(new Date(), timezone);
  }

  settleEmployee(employeeId: string, from: IsoDate, to: IsoDate): Promise<void> {
    return this.settle(from, to, [employeeId]);
  }

  /**
   * Settles the tenant's live employees over the dates (never past today). `employees` narrows it to
   * ids or to a filter — pass the view's own filter so a read only pays for the rows it shows.
   */
  async settle(from: IsoDate, to: IsoDate, employees?: readonly string[] | Prisma.EmployeeWhereInput): Promise<void> {
    if (Array.isArray(employees) && employees.length === 0) return;
    const end = minDate(to, await this.today());
    if (from > end) return;
    const range = { gte: toDbDate(from), lte: toDbDate(end) };
    const narrow: Prisma.EmployeeWhereInput = Array.isArray(employees) ? { id: { in: [...employees] } } : ((employees as Prisma.EmployeeWhereInput | undefined) ?? {});
    const [candidates, locked] = await Promise.all([
      this.db.tenant.employee.findMany({
        where: {
          AND: [narrow],
          dateOfJoining: { lte: toDbDate(end) },
          OR: [{ status: { in: ['ACTIVE', 'INVITED'] } }, { exitDate: { gte: toDbDate(from) } }],
        },
        select: { id: true, dateOfJoining: true, exitDate: true },
      }),
      this.db.tenant.payPeriod.findMany({
        where: { status: 'LOCKED', month: { gte: toDbDate(`${monthOf(from)}-01`), lte: toDbDate(`${monthOf(end)}-01`) } },
        select: { month: true },
      }),
    ]);
    if (candidates.length === 0) return;
    const stored = await this.db.tenant.attendanceDay.findMany({
      where: { employeeId: { in: candidates.map((e) => e.id) }, attendanceDate: range },
      select: { employeeId: true, attendanceDate: true, isFinalized: true, windowEndAt: true, needsRecompute: true, engineVersion: true, periodLocked: true },
    });
    const rows = new Map<string, StoredDayState[]>();
    for (const r of stored) {
      const list = rows.get(r.employeeId) ?? [];
      list.push({ ...r, date: dateOnly(r.attendanceDate) as string });
      rows.set(r.employeeId, list);
    }
    const tasks = planSettle({
      employees: candidates.map((e) => ({ id: e.id, joinDate: dateOnly(e.dateOfJoining) as string, exitDate: dateOnly(e.exitDate) })),
      rows,
      from,
      to: end,
      lockedMonths: new Set(locked.map((p) => monthOf(dateOnly(p.month) as string))),
      now: new Date(),
      engineVersion: ATTENDANCE_ENGINE_VERSION,
    });
    // A failed employee must not block the read; the row stays due and the next read retries it.
    await forEachLimit(tasks, CONCURRENCY, async (task) => {
      try {
        await this.days.recomputeRange(task.employeeId, task.from, task.to);
      } catch (error: unknown) {
        this.logger.error(`Settle ${task.employeeId} ${task.from}..${task.to} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  }
}
