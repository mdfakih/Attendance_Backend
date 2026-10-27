import { Injectable, Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { runAsTenant } from '../core/context/request-context.js';
import { DbService } from '../core/database/db.service.js';
import { StorageService } from '../core/storage/storage.service.js';
import { localDateOf, toDbDate } from '../engines/time/dates.js';
import { LeaveService } from '../modules/leave/leave.service.js';

@Injectable()
export class MaintenanceProcessor {
  private readonly logger = new Logger(MaintenanceProcessor.name);

  constructor(
    private readonly db: DbService,
    private readonly storage: StorageService,
    private readonly leave: LeaveService,
  ) {}

  async handle(job: Job): Promise<void> {
    switch (job.name) {
      case 'daily':
        return this.daily();
      default:
        this.logger.warn(`Unknown maintenance job ${job.name}`);
    }
  }

  private async daily(): Promise<void> {
    const tenants = await this.db.platform.tenant.findMany({ where: { status: { not: 'CANCELLED' } }, select: { id: true, timezone: true } });
    for (const t of tenants) {
      await runAsTenant(t.id, async () => {
        const today = localDateOf(new Date(), t.timezone);
        await this.purgeSelfies(t.id);
        await this.accrueLeave(t.id, today);
        await this.snapshotUsage(t.id, today);
      }).catch((error: unknown) => this.logger.error(`Daily maintenance failed for ${t.id}: ${error instanceof Error ? error.message : String(error)}`));
    }
    await this.billingChecks();
    await this.expireCodes();
  }

  private async purgeSelfies(tenantId: string): Promise<void> {
    const settings = await this.db.tenant.tenantSettings.findUnique({ where: { tenantId } });
    const days = settings?.selfieRetentionDays ?? 90;
    const cutoff = new Date(Date.now() - days * 86_400_000);
    const rows = await this.db.tenant.punch.findMany({
      where: { selfieKey: { not: null }, selfiePurgedAt: null, serverTime: { lt: cutoff } },
      select: { id: true, selfieKey: true, thumbKey: true },
      take: 2000,
    });
    if (rows.length === 0) return;
    await this.storage.deleteMany(rows.flatMap((r) => [r.selfieKey, r.thumbKey]).filter((k): k is string => !!k));
    await this.db.tenant.punch.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { selfiePurgedAt: new Date() } });
    this.logger.log(`Purged ${rows.length} selfies for tenant ${tenantId}`);
  }

  private async accrueLeave(tenantId: string, today: string): Promise<void> {
    const feature = await this.db.tenant.tenantFeature.findUnique({ where: { tenantId_key: { tenantId, key: 'LEAVE' } } });
    if (!feature?.enabled) return;
    await this.leave.accrueYear(tenantId, Number(today.slice(0, 4)));
    await this.leave.accrueMonth(tenantId, today.slice(0, 7));
  }

  private async snapshotUsage(tenantId: string, today: string): Promise<void> {
    const [active, invited, punches, webUsers] = await Promise.all([
      this.db.tenant.employee.count({ where: { status: 'ACTIVE' } }),
      this.db.tenant.employee.count({ where: { status: 'INVITED' } }),
      this.db.tenant.punch.count({ where: { attendanceDate: toDbDate(today) } }),
      this.db.tenant.tenantMembership.count({ where: { status: 'ACTIVE' } }),
    ]);
    await this.db.platform.usageDailySnapshot.upsert({
      where: { tenantId_snapshotDate: { tenantId, snapshotDate: toDbDate(today) } },
      update: { activeEmployees: active, invitedEmployees: invited, punches, webUsers },
      create: { tenantId, snapshotDate: toDbDate(today), activeEmployees: active, invitedEmployees: invited, punches, webUsers },
    });
  }

  /** Overdue charges and ended trials move the subscription (and tenant) to PAST_DUE. Suspension stays manual. */
  private async billingChecks(): Promise<void> {
    const today = toDbDate(new Date().toISOString().slice(0, 10));
    const overdue = await this.db.platform.subscriptionCharge.findMany({ where: { status: 'DUE', dueDate: { lt: today } } });
    for (const c of overdue) {
      await this.db.platform.subscriptionCharge.update({ where: { id: c.id }, data: { status: 'OVERDUE' } });
      await this.markPastDue(c.tenantId, 'Charge overdue');
    }
    const trials = await this.db.platform.subscription.findMany({ where: { status: 'TRIALING', trialEndsAt: { lt: today } } });
    for (const s of trials) {
      await this.markPastDue(s.tenantId, 'Trial ended');
    }
  }

  private async markPastDue(tenantId: string, reason: string): Promise<void> {
    const sub = await this.db.platform.subscription.findUnique({ where: { tenantId } });
    if (!sub || sub.status === 'SUSPENDED' || sub.status === 'CANCELLED' || sub.status === 'PAST_DUE') return;
    await this.db.platform.$transaction([
      this.db.platform.subscription.update({ where: { tenantId }, data: { status: 'PAST_DUE' } }),
      this.db.platform.tenant.updateMany({ where: { id: tenantId, status: { in: ['TRIAL', 'ACTIVE'] } }, data: { status: 'PAST_DUE', statusReason: reason } }),
      this.db.platform.subscriptionEvent.create({
        data: { tenantId, subscriptionId: sub.id, eventType: 'PAST_DUE', fromStatus: sub.status, toStatus: 'PAST_DUE', payload: { reason }, actorType: 'SYSTEM' },
      }),
    ]);
  }

  private async expireCodes(): Promise<void> {
    const result = await this.db.platform.activationCode.updateMany({
      where: { status: 'ISSUED', expiresAt: { lt: new Date() } },
      data: { status: 'EXPIRED', liveKey: null, codeEnc: null },
    });
    if (result.count > 0) this.logger.log(`Expired ${result.count} activation codes`);
  }
}
