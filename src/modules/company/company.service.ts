import { Injectable } from '@nestjs/common';
import { featureViews, resolveBranding, type FeatureToggleInput, type PaySettingsInput, type TenantSettingsInput } from '@attendance/contracts';
import { Decimal } from 'decimal.js';
import { AuditService } from '../../core/audit/audit.service.js';
import { PrincipalService } from '../../core/auth/principal.service.js';
import { requireContext, requireTenantId, requireTenantUser } from '../../core/context/request-context.js';
import { DbService } from '../../core/database/db.service.js';
import { AppError, notFound } from '../../core/http/app-error.js';
import { dateOnly, money } from '../../common/serialize.js';
import { isUniqueViolation } from '../../common/unique-retry.js';
import { addDays, localDateOf } from '../../engines/time/dates.js';
import { AttendanceDayService } from '../attendance/attendance-day.service.js';

/** How far back a change of company working hours is applied to existing days. */
const RECOMPUTE_BACK_DAYS = 31;

@Injectable()
export class CompanyService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly principals: PrincipalService,
    private readonly days: AttendanceDayService,
  ) {}

  async me() {
    const ctx = requireContext();
    const tenantUser = requireTenantUser();
    const tenantId = requireTenantId();
    const [user, role, tenant, settings] = await Promise.all([
      this.db.platform.user.findUniqueOrThrow({ where: { id: tenantUser.userId }, select: { id: true, email: true, fullName: true } }),
      this.db.tenant.role.findUniqueOrThrow({ where: { id: tenantUser.roleId }, select: { id: true, name: true, kind: true } }),
      this.db.platform.tenant.findUniqueOrThrow({ where: { id: tenantId } }),
      this.db.tenant.tenantSettings.findUnique({ where: { tenantId } }),
    ]);
    return {
      user,
      membershipId: tenantUser.membershipId,
      role,
      permissions: tenantUser.permissions,
      scopes: { branchIds: tenantUser.branchIds, departmentIds: tenantUser.departmentIds },
      tenant: {
        id: tenant.id,
        displayName: tenant.displayName,
        legalName: tenant.legalName,
        timezone: tenant.timezone,
        status: tenant.status,
        payrollTier: tenant.payrollTier,
        stateCode: tenant.stateCode,
        branding: resolveBranding(tenant.branding),
      },
      features: ctx.features,
      settings: settings && this.settingsDto(settings),
    };
  }

  async settings() {
    const settings = await this.db.tenant.tenantSettings.findUnique({ where: { tenantId: requireTenantId() } });
    if (!settings) throw notFound('Settings');
    return this.settingsDto(settings);
  }

  async updateSettings(input: TenantSettingsInput) {
    const tenantId = requireTenantId();
    const before = await this.db.tenant.tenantSettings.findUniqueOrThrow({ where: { tenantId } });
    const { timezone, ...rest } = input;
    if (rest.defaultShiftId) {
      const shift = await this.db.tenant.shift.findUnique({ where: { id: rest.defaultShiftId } });
      if (!shift) throw new AppError('VALIDATION_FAILED', 'Unknown shift.');
    }
    const after = await this.db.tenant.tenantSettings.update({
      where: { tenantId },
      data: {
        activationCodeTtlDays: rest.activationCodeTtlDays,
        defaultSiteRadiusM: rest.defaultSiteRadiusM,
        defaultMaxAccuracyM: rest.defaultMaxAccuracyM,
        accuracyBufferCapM: rest.accuracyBufferCapM,
        selfieRetentionDays: rest.selfieRetentionDays,
        missingOutReminder: rest.missingOutReminder,
        defaultShiftId: rest.defaultShiftId,
      },
    });
    if (timezone) {
      await this.db.platform.tenant.update({ where: { id: tenantId }, data: { timezone } });
    }
    if (rest.defaultShiftId !== undefined && rest.defaultShiftId !== before.defaultShiftId) {
      const tenant = await this.db.platform.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { timezone: true } });
      const today = localDateOf(new Date(), tenant.timezone);
      await this.days.markStale('ALL', addDays(today, -RECOMPUTE_BACK_DAYS), today);
    }
    await this.audit.record({ action: 'tenant.settings.update', entityType: 'tenant_settings', entityId: tenantId, before, after });
    return this.settingsDto(after);
  }

  async updatePaySettings(input: PaySettingsInput) {
    const tenantId = requireTenantId();
    const before = await this.db.tenant.tenantSettings.findUniqueOrThrow({ where: { tenantId } });
    const after = await this.db.tenant.tenantSettings.update({
      where: { tenantId },
      data: { payableDaysBasis: input.payableDaysBasis, defaultOtMultiplier: new Decimal(input.defaultOtMultiplier) },
    });
    // Every open month's pay depends on these; recompute on next read.
    await this.db.tenant.employeePaySummary.updateMany({ where: { status: 'OPEN' }, data: { isStale: true } });
    await this.audit.record({ action: 'tenant.pay_settings.update', entityType: 'tenant_settings', entityId: tenantId, before, after });
    return this.settingsDto(after);
  }

  async features() {
    const tenantId = requireTenantId();
    const [state, rows] = await Promise.all([
      this.principals.features(tenantId),
      this.db.tenant.tenantFeature.findMany({ where: { tenantId }, select: { key: true, lockedByPlatform: true } }),
    ]);
    return featureViews(state, rows);
  }

  async toggleFeature(input: FeatureToggleInput) {
    const tenantId = requireTenantId();
    const actor = requireContext().actor;
    const data = { enabled: input.enabled, updatedByActor: actor.type, updatedById: actor.id };
    // Conditional on the lock so a platform lock landing mid-request is never overwritten.
    const updated = await this.db.tenant.tenantFeature.updateMany({ where: { tenantId, key: input.key, lockedByPlatform: false }, data });
    if (updated.count === 0) {
      const existing = await this.db.tenant.tenantFeature.findUnique({ where: { tenantId_key: { tenantId, key: input.key } } });
      if (existing) throw new AppError('FEATURE_LOCKED');
      try {
        await this.db.tenant.tenantFeature.create({ data: { tenantId, key: input.key, ...data } });
      } catch (error: unknown) {
        if (!isUniqueViolation(error)) throw error;
        // Someone created the row first; apply ours only if they did not lock it.
        const retried = await this.db.tenant.tenantFeature.updateMany({ where: { tenantId, key: input.key, lockedByPlatform: false }, data });
        if (retried.count === 0) throw new AppError('FEATURE_LOCKED');
      }
    }
    await this.db.tenant.tenantSettings.update({ where: { tenantId }, data: { featuresVersion: { increment: 1 } } });
    await this.audit.record({ action: 'tenant.feature.update', entityType: 'tenant_feature', entityId: tenantId, after: input });
    await this.principals.invalidateTenant(tenantId);
    return this.features();
  }

  async subscription() {
    const tenantId = requireTenantId();
    const sub = await this.db.platform.subscription.findUnique({ where: { tenantId }, include: { plan: true } });
    const charges = await this.db.platform.subscriptionCharge.findMany({
      where: { tenantId, status: { not: 'DRAFT' } },
      orderBy: { periodStart: 'desc' },
      take: 12,
    });
    return {
      plan: sub?.plan.name ?? null,
      status: sub?.status ?? null,
      currentPeriodStart: dateOnly(sub?.currentPeriodStart),
      currentPeriodEnd: dateOnly(sub?.currentPeriodEnd),
      trialEndsAt: dateOnly(sub?.trialEndsAt),
      pricePerEmployee: money(sub?.priceOverride ?? sub?.plan.pricePerEmployee),
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
    };
  }

  private settingsDto(s: Awaited<ReturnType<DbService['platform']['tenantSettings']['findUniqueOrThrow']>>) {
    return {
      payableDaysBasis: s.payableDaysBasis,
      defaultOtMultiplier: s.defaultOtMultiplier.toFixed(2),
      activationCodeTtlDays: s.activationCodeTtlDays,
      defaultSiteRadiusM: s.defaultSiteRadiusM,
      defaultMaxAccuracyM: s.defaultMaxAccuracyM,
      accuracyBufferCapM: s.accuracyBufferCapM,
      selfieRetentionDays: s.selfieRetentionDays,
      missingOutReminder: s.missingOutReminder,
      defaultPolicyId: s.defaultPolicyId,
      defaultCalendarId: s.defaultCalendarId,
      defaultPatternId: s.defaultPatternId,
      defaultShiftId: s.defaultShiftId,
    };
  }
}
