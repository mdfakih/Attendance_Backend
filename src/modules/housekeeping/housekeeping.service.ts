import { Injectable, Logger } from '@nestjs/common';
import { runInBackground } from '../../core/background.js';
import { requireTenantId, runAsTenant } from '../../core/context/request-context.js';
import { DbService } from '../../core/database/db.service.js';
import { StorageService } from '../../core/storage/storage.service.js';
import { addDays, type IsoDate, toDbDate } from '../../engines/time/dates.js';
import { AttendanceSettleService } from '../attendance/attendance-settle.service.js';
import { LeaveService } from '../leave/leave.service.js';

const PURGE_BATCH = 2000;

/**
 * Replaces the nightly maintenance job. The first request of a tenant's local day claims the day
 * (atomically, so exactly one request runs it) and the work continues after the response.
 *
 * Selfie retention does not depend on this alone: reads hide selfies past retention, and the
 * bucket's lifecycle rule should expire `t/<tenant>/selfies/` objects as the backstop.
 */
@Injectable()
export class HousekeepingService {
  private readonly logger = new Logger(HousekeepingService.name);
  /** tenantId → local date this instance already checked; avoids a database round trip per request. */
  private readonly checked = new Map<string, IsoDate>();

  constructor(
    private readonly db: DbService,
    private readonly storage: StorageService,
    private readonly settle: AttendanceSettleService,
    private readonly leave: LeaveService,
  ) {}

  /** Call from requests that start a tenant's day (dashboard, app open). Never blocks or throws. */
  ensureToday(): void {
    const tenantId = requireTenantId();
    // As the system actor, not as whichever user happened to trigger it.
    runInBackground(`Housekeeping for ${tenantId}`, this.logger, () => runAsTenant(tenantId, () => this.runIfDue(tenantId)));
  }

  /**
   * Billing status for every tenant, including ones nobody opens (whose own housekeeping never runs).
   * Called from the superadmin console; cheap when nothing is overdue.
   */
  async billingChecksAll(): Promise<void> {
    const cutoff = new Date(new Date().toISOString().slice(0, 10));
    const [overdue, trials] = await Promise.all([
      this.db.platform.subscriptionCharge.findMany({ where: { status: 'DUE', dueDate: { lt: cutoff } }, select: { tenantId: true } }),
      this.db.platform.subscription.findMany({ where: { status: 'TRIALING', trialEndsAt: { lt: cutoff } }, select: { tenantId: true } }),
    ]);
    const tenantIds = new Set([...overdue, ...trials].map((r) => r.tenantId));
    for (const tenantId of tenantIds) {
      await this.billingChecks(tenantId, cutoff.toISOString().slice(0, 10));
    }
  }

  private async runIfDue(tenantId: string): Promise<void> {
    const today = await this.settle.today();
    if (this.checked.get(tenantId) === today) return;
    const claimed = await this.db.tenant.tenantSettings.updateMany({
      where: { tenantId, OR: [{ housekeptOn: null }, { housekeptOn: { lt: toDbDate(today) } }] },
      data: { housekeptOn: toDbDate(today) },
    });
    this.checked.set(tenantId, today);
    if (claimed.count === 0) return;
    const steps: ReadonlyArray<readonly [string, () => Promise<void>]> = [
      ['selfie purge', () => this.purgeSelfies(tenantId)],
      ['leave accrual', () => this.accrueLeave(tenantId, today)],
      ['usage snapshot', () => this.snapshotUsage(tenantId, addDays(today, -1))],
      ['billing checks', () => this.billingChecks(tenantId, today)],
      ['code expiry', () => this.expireCodes(tenantId)],
    ];
    let failed = false;
    for (const [name, step] of steps) {
      try {
        await step();
      } catch (error: unknown) {
        failed = true;
        this.logger.error(`Housekeeping ${name} failed for ${tenantId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (failed) {
      // Every step is idempotent, so give the day back and let a later request retry all of them.
      await this.db.tenant.tenantSettings.updateMany({ where: { tenantId }, data: { housekeptOn: null } });
      this.checked.delete(tenantId);
    }
  }

  private async purgeSelfies(tenantId: string): Promise<void> {
    const settings = await this.db.tenant.tenantSettings.findUnique({ where: { tenantId } });
    const cutoff = new Date(Date.now() - (settings?.selfieRetentionDays ?? 90) * 86_400_000);
    const rows = await this.db.tenant.punch.findMany({
      where: { selfieKey: { not: null }, selfiePurgedAt: null, serverTime: { lt: cutoff } },
      select: { id: true, selfieKey: true, thumbKey: true },
      take: PURGE_BATCH,
    });
    if (rows.length === 0) return;
    await this.storage.deleteMany(rows.flatMap((r) => [r.selfieKey, r.thumbKey]).filter((k): k is string => !!k));
    await this.db.tenant.punch.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { selfiePurgedAt: new Date() } });
    this.logger.log(`Purged ${rows.length} selfies for tenant ${tenantId}`);
  }

  private async accrueLeave(tenantId: string, today: IsoDate): Promise<void> {
    const feature = await this.db.tenant.tenantFeature.findUnique({ where: { tenantId_key: { tenantId, key: 'LEAVE' } } });
    if (!feature?.enabled) return;
    await this.leave.accrueYear(tenantId, Number(today.slice(0, 4)));
    await this.leave.accrueMonth(tenantId, today.slice(0, 7));
  }

  /** Records the finished previous day: its punches and the current headcounts. */
  private async snapshotUsage(tenantId: string, day: IsoDate): Promise<void> {
    const [active, invited, punches, webUsers] = await Promise.all([
      this.db.tenant.employee.count({ where: { status: 'ACTIVE' } }),
      this.db.tenant.employee.count({ where: { status: 'INVITED' } }),
      this.db.tenant.punch.count({ where: { attendanceDate: toDbDate(day) } }),
      this.db.tenant.tenantMembership.count({ where: { status: 'ACTIVE' } }),
    ]);
    await this.db.platform.usageDailySnapshot.upsert({
      where: { tenantId_snapshotDate: { tenantId, snapshotDate: toDbDate(day) } },
      update: { activeEmployees: active, invitedEmployees: invited, punches, webUsers },
      create: { tenantId, snapshotDate: toDbDate(day), activeEmployees: active, invitedEmployees: invited, punches, webUsers },
    });
  }

  /** Overdue charges and ended trials move the subscription (and tenant) to PAST_DUE. Suspension stays manual. */
  private async billingChecks(tenantId: string, today: IsoDate): Promise<void> {
    const cutoff = toDbDate(today);
    const overdue = await this.db.platform.subscriptionCharge.findMany({ where: { tenantId, status: 'DUE', dueDate: { lt: cutoff } } });
    for (const c of overdue) {
      await this.db.platform.subscriptionCharge.update({ where: { id: c.id }, data: { status: 'OVERDUE' } });
    }
    if (overdue.length > 0) {
      await this.markPastDue(tenantId, 'Charge overdue');
      return;
    }
    const trialEnded = await this.db.platform.subscription.count({ where: { tenantId, status: 'TRIALING', trialEndsAt: { lt: cutoff } } });
    if (trialEnded > 0) await this.markPastDue(tenantId, 'Trial ended');
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

  /** Codes are already refused once expired; this clears their reveal-able encrypted copy. */
  private async expireCodes(tenantId: string): Promise<void> {
    await this.db.platform.activationCode.updateMany({
      where: { tenantId, status: 'ISSUED', expiresAt: { lt: new Date() } },
      data: { status: 'EXPIRED', liveKey: null, codeEnc: null },
    });
  }
}
