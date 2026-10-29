import { Inject, Injectable } from '@nestjs/common';
import type { TenantStatus, UpdateTenantInput } from '@attendance/contracts';
import { AuditService } from '../../core/audit/audit.service.js';
import { PrincipalService } from '../../core/auth/principal.service.js';
import { ENV, type Env } from '../../core/config/env.js';
import { randomToken, sha256Hex } from '../../core/crypto/crypto.util.js';
import { DbService } from '../../core/database/db.service.js';
import { AppError, notFound } from '../../core/http/app-error.js';
import { NotifyService } from '../../core/notify/notify.service.js';
import { HousekeepingService } from '../housekeeping/housekeeping.service.js';
import { dateOnly, iso, money } from '../../common/serialize.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { assertTierAvailable } from './onboarding.service.js';

export interface TenantListQuery {
  readonly page: number;
  readonly pageSize: number;
  readonly q?: string;
  readonly status?: TenantStatus;
}

@Injectable()
export class TenantsService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly principals: PrincipalService,
    private readonly notify: NotifyService,
    private readonly housekeeping: HousekeepingService,
  ) {}

  async list(query: TenantListQuery) {
    // Tenants nobody opens never run their own housekeeping; keep their billing status current here.
    await this.housekeeping.billingChecksAll();
    const where: Prisma.TenantWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.q
        ? {
            OR: [
              { displayName: { contains: query.q, mode: 'insensitive' } },
              { legalName: { contains: query.q, mode: 'insensitive' } },
              { slug: { contains: query.q.toLowerCase() } },
            ],
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.db.platform.tenant.findMany({
        where,
        include: { subscription: { include: { plan: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.db.platform.tenant.count({ where }),
    ]);
    const counts = await this.db.platform.employee.groupBy({
      by: ['tenantId'],
      where: { tenantId: { in: rows.map((r) => r.id) }, status: { in: ['ACTIVE', 'INVITED'] } },
      _count: { _all: true },
    });
    const countMap = new Map(counts.map((c) => [c.tenantId, c._count._all]));
    const items = rows.map((t) => ({
      id: t.id,
      slug: t.slug,
      displayName: t.displayName,
      legalName: t.legalName,
      status: t.status,
      payrollTier: t.payrollTier,
      employeeCap: t.employeeCap,
      employees: countMap.get(t.id) ?? 0,
      plan: t.subscription?.plan.name ?? null,
      subscriptionStatus: t.subscription?.status ?? null,
      currentPeriodEnd: dateOnly(t.subscription?.currentPeriodEnd),
      createdAt: iso(t.createdAt),
    }));
    return { items, total };
  }

  async detail(tenantId: string) {
    const tenant = await this.db.platform.tenant.findUnique({
      where: { id: tenantId },
      include: { settings: true, subscription: { include: { plan: true } } },
    });
    if (!tenant) {
      throw notFound('Tenant');
    }
    const [active, invited, admins, charges, payments] = await Promise.all([
      this.db.platform.employee.count({ where: { tenantId, status: 'ACTIVE' } }),
      this.db.platform.employee.count({ where: { tenantId, status: 'INVITED' } }),
      this.db.platform.tenantMembership.findMany({
        where: { tenantId, role: { kind: 'ADMIN' } },
        include: { user: { select: { email: true, fullName: true, lastLoginAt: true } } },
      }),
      this.db.platform.subscriptionCharge.findMany({ where: { tenantId }, orderBy: { periodStart: 'desc' }, take: 12 }),
      this.db.platform.payment.findMany({ where: { tenantId }, orderBy: { receivedOn: 'desc' }, take: 12 }),
    ]);
    const pendingInvites = await this.db.platform.userInvitation.findMany({
      where: { tenantId, acceptedAt: null, revokedAt: null },
      select: { id: true, email: true, fullName: true, expiresAt: true },
    });
    const sub = tenant.subscription;
    return {
      id: tenant.id,
      slug: tenant.slug,
      displayName: tenant.displayName,
      legalName: tenant.legalName,
      gstin: tenant.gstin,
      stateCode: tenant.stateCode,
      billingEmail: tenant.billingEmail,
      timezone: tenant.timezone,
      status: tenant.status,
      statusReason: tenant.statusReason,
      payrollTier: tenant.payrollTier,
      employeeCap: tenant.employeeCap,
      createdAt: iso(tenant.createdAt),
      employees: { active, invited },
      admins: admins.map((a) => ({ email: a.user.email, fullName: a.user.fullName, lastLoginAt: iso(a.user.lastLoginAt) })),
      pendingInvites: pendingInvites.map((i) => ({ ...i, expiresAt: iso(i.expiresAt) })),
      subscription: sub && {
        id: sub.id,
        planId: sub.planId,
        planName: sub.plan.name,
        status: sub.status,
        currentPeriodStart: dateOnly(sub.currentPeriodStart),
        currentPeriodEnd: dateOnly(sub.currentPeriodEnd),
        nextDueDate: dateOnly(sub.nextDueDate),
        trialEndsAt: dateOnly(sub.trialEndsAt),
        priceOverride: money(sub.priceOverride),
        pricePerEmployee: money(sub.plan.pricePerEmployee),
        notes: sub.notes,
      },
      charges: charges.map((c) => ({
        id: c.id,
        periodStart: dateOnly(c.periodStart),
        periodEnd: dateOnly(c.periodEnd),
        billableEmployees: c.billableEmployees,
        total: money(c.total),
        amountPaid: money(c.amountPaid),
        status: c.status,
        dueDate: dateOnly(c.dueDate),
        invoiceNo: c.invoiceNo,
      })),
      payments: payments.map((p) => ({
        id: p.id,
        amount: money(p.amount),
        method: p.method,
        referenceNo: p.referenceNo,
        receivedOn: dateOnly(p.receivedOn),
        status: p.status,
      })),
    };
  }

  async update(tenantId: string, input: UpdateTenantInput) {
    if (input.payrollTier) {
      assertTierAvailable(input.payrollTier);
    }
    const before = await this.db.platform.tenant.findUnique({ where: { id: tenantId } });
    if (!before) {
      throw notFound('Tenant');
    }
    const after = await this.db.platform.tenant.update({ where: { id: tenantId }, data: input });
    await this.audit.record({ action: 'tenant.update', entityType: 'tenant', entityId: tenantId, before, after, tenantId });
    return this.detail(tenantId);
  }

  async setStatus(tenantId: string, status: 'SUSPENDED' | 'ACTIVE', reason: string) {
    const tenant = await this.db.platform.tenant.findUnique({ where: { id: tenantId }, include: { subscription: true } });
    if (!tenant) {
      throw notFound('Tenant');
    }
    if (status === 'ACTIVE' && tenant.status !== 'SUSPENDED' && tenant.status !== 'PAST_DUE') {
      throw new AppError('CONFLICT', 'Only suspended or past-due tenants can be reactivated.');
    }
    await this.db.platform.$transaction(async (tx) => {
      await tx.tenant.update({ where: { id: tenantId }, data: { status, statusReason: reason } });
      if (tenant.subscription) {
        const subStatus = status === 'SUSPENDED' ? 'SUSPENDED' : 'ACTIVE';
        await tx.subscription.update({
          where: { id: tenant.subscription.id },
          data: {
            status: subStatus,
            suspendedAt: status === 'SUSPENDED' ? new Date() : null,
            suspendReason: status === 'SUSPENDED' ? reason : null,
          },
        });
        await tx.subscriptionEvent.create({
          data: {
            tenantId,
            subscriptionId: tenant.subscription.id,
            eventType: status === 'SUSPENDED' ? 'SUSPENDED' : 'REACTIVATED',
            fromStatus: tenant.subscription.status,
            toStatus: subStatus,
            payload: { reason },
            actorType: 'PLATFORM_USER',
          },
        });
      }
      await this.audit.record(
        { action: status === 'SUSPENDED' ? 'tenant.suspend' : 'tenant.reactivate', entityType: 'tenant', entityId: tenantId, reason, tenantId },
        tx,
      );
    });
    await this.principals.invalidateTenant(tenantId);
    return this.detail(tenantId);
  }

  async resendAdminInvite(tenantId: string, email: string): Promise<{ inviteLink: string }> {
    const invite = await this.db.platform.userInvitation.findFirst({
      where: { tenantId, email, acceptedAt: null, revokedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    if (!invite) {
      throw notFound('Pending invitation');
    }
    const token = randomToken(32);
    await this.db.platform.userInvitation.update({
      where: { id: invite.id },
      data: { tokenHash: sha256Hex(token), expiresAt: new Date(Date.now() + 7 * 86_400_000) },
    });
    const inviteLink = `${this.env.WEB_APP_URL}/accept-invite?token=${token}`;
    await this.notify.email({
      to: email,
      subject: 'Your Admin invitation',
      text: `Set up your account here (valid for 7 days):\n${inviteLink}\n`,
    });
    return { inviteLink };
  }

  async usage(tenantId: string) {
    const rows = await this.db.platform.usageDailySnapshot.findMany({
      where: { tenantId },
      orderBy: { snapshotDate: 'desc' },
      take: 60,
    });
    return rows.map((r) => ({ ...r, snapshotDate: dateOnly(r.snapshotDate) }));
  }
}
