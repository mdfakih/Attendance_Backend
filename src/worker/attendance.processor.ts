import { Injectable, Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { runAsTenant } from '../core/context/request-context.js';
import { DbService } from '../core/database/db.service.js';
import { QUEUE, type PushJob, type RecomputeDayJob, type RecomputeRangeJob, type TenantJob } from '../core/queue/queues.js';
import { QueueService } from '../core/queue/queue.service.js';
import { addDays, localDateOf } from '../engines/time/dates.js';
import { AttendanceDayService } from '../modules/attendance/attendance-day.service.js';

const CHUNK = 200;
const REMINDER_AFTER_MIN = 30;

@Injectable()
export class AttendanceProcessor {
  private readonly logger = new Logger(AttendanceProcessor.name);

  constructor(
    private readonly db: DbService,
    private readonly days: AttendanceDayService,
    private readonly queues: QueueService,
  ) {}

  async handle(job: Job): Promise<void> {
    switch (job.name) {
      case 'recompute-day':
        return this.recomputeDay(job.data as RecomputeDayJob);
      case 'recompute-range':
        return this.recomputeRange(job.data as RecomputeRangeJob);
      case 'tick':
        return this.tickAll();
      case 'tick-tenant':
        return this.tickTenant(job.data as TenantJob);
      case 'ensure-days':
        return this.ensureDaysAll();
      default:
        this.logger.warn(`Unknown attendance job ${job.name}`);
    }
  }

  private recomputeDay(data: RecomputeDayJob): Promise<void> {
    return runAsTenant(data.tenantId, async () => {
      await this.days.recomputeDay(data.employeeId, data.date);
    });
  }

  private recomputeRange(data: RecomputeRangeJob): Promise<void> {
    return runAsTenant(data.tenantId, async () => {
      const ids =
        data.employeeIds === 'ALL'
          ? (await this.db.tenant.employee.findMany({ where: { status: { in: ['ACTIVE', 'INVITED'] } }, select: { id: true } })).map((e) => e.id)
          : [...data.employeeIds];
      for (let i = 0; i < ids.length; i += CHUNK) {
        await Promise.all(ids.slice(i, i + CHUNK).map((id) => this.days.recomputeRange(id, data.from, data.to)));
      }
    });
  }

  /** Fans out one tick job per live tenant. */
  private async tickAll(): Promise<void> {
    const tenants = await this.db.platform.tenant.findMany({ where: { status: { in: ['TRIAL', 'ACTIVE', 'PAST_DUE'] } }, select: { id: true } });
    for (const t of tenants) {
      await this.queues.add(QUEUE.ATTENDANCE, 'tick-tenant', { tenantId: t.id } satisfies TenantJob, { jobId: `tick-${t.id}-${Math.floor(Date.now() / 300_000)}` });
    }
  }

  /** Finalizes days whose window closed and sends missing-out reminders. */
  private tickTenant(data: TenantJob): Promise<void> {
    return runAsTenant(data.tenantId, async () => {
      const now = new Date();
      const due = await this.db.tenant.attendanceDay.findMany({
        where: { isFinalized: false, windowEndAt: { lte: now } },
        select: { employeeId: true, attendanceDate: true },
        take: 2000,
      });
      for (const d of due) {
        await this.days.recomputeDay(d.employeeId, d.attendanceDate.toISOString().slice(0, 10));
      }
      const settings = await this.db.tenant.tenantSettings.findUnique({ where: { tenantId: data.tenantId } });
      if (!settings?.missingOutReminder) return;
      const cutoff = new Date(now.getTime() - REMINDER_AFTER_MIN * 60_000);
      const open = await this.db.tenant.attendanceDay.findMany({
        where: { isFinalized: false, missingOutRemindedAt: null, expectedEndAt: { lte: cutoff }, punchCount: { gt: 0 } },
        select: { id: true, employeeId: true, punchCount: true },
        take: 1000,
      });
      for (const d of open.filter((x) => x.punchCount % 2 === 1)) {
        await this.queues.add(QUEUE.NOTIFY, 'push', {
          tenantId: data.tenantId,
          employeeId: d.employeeId,
          title: 'Did you forget to punch out?',
          body: 'Your shift has ended. Open the app and punch out.',
          data: { type: 'MISSING_OUT' },
        } satisfies PushJob);
        await this.db.tenant.attendanceDay.update({ where: { id: d.id }, data: { missingOutRemindedAt: now } });
      }
    });
  }

  /** Makes sure yesterday and today have rows for every live employee (absent marking, dashboards). */
  private async ensureDaysAll(): Promise<void> {
    const tenants = await this.db.platform.tenant.findMany({ where: { status: { in: ['TRIAL', 'ACTIVE', 'PAST_DUE'] } }, select: { id: true, timezone: true } });
    for (const t of tenants) {
      const today = localDateOf(new Date(), t.timezone);
      await this.queues.add(QUEUE.ATTENDANCE, 'recompute-range', { tenantId: t.id, employeeIds: 'ALL', from: addDays(today, -1), to: today } satisfies RecomputeRangeJob, {
        jobId: `ensure-${t.id}-${today}-${new Date().getUTCHours()}`,
      });
    }
  }
}
