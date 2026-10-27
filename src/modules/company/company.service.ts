import { Injectable } from '@nestjs/common';
import { FEATURE_REGISTRY, FEATURE_KEYS, type FeatureToggleInput, type PaySettingsInput, type TenantSettingsInput } from '@attendance/contracts';
import { Decimal } from 'decimal.js';
import { AuditService } from '../../core/audit/audit.service.js';
import { PrincipalService } from '../../core/auth/principal.service.js';
import { requireContext, requireTenantId, requireTenantUser } from '../../core/context/request-context.js';
import { DbService } from '../../core/database/db.service.js';
import { notFound } from '../../core/http/app-error.js';
import { dateOnly, money } from '../../common/serialize.js';

@Injectable()
export class CompanyService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly principals: PrincipalService,
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
    const after = await this.db.tenant.tenantSettings.update({
      where: { tenantId },
      data: {
        activationCodeTtlDays: rest.activationCodeTtlDays,
        defaultSiteRadiusM: rest.defaultSiteRadiusM,
        defaultMaxAccuracyM: rest.defaultMaxAccuracyM,
        accuracyBufferCapM: rest.accuracyBufferCapM,
        selfieRetentionDays: rest.selfieRetentionDays,
        missingOutReminder: rest.missingOutReminder,
      },
    });
    if (timezone) {
      await this.db.platform.tenant.update({ where: { id: tenantId }, data: { timezone } });
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
    await this.audit.record({ action: 'tenant.pay_settings.update', entityType: 'tenant_settings', entityId: tenantId, before, after });
    return this.settingsDto(after);
  }

  async features() {
    const tenantId = requireTenantId();
    const state = await this.principals.features(tenantId);
    return FEATURE_KEYS.map((key) => ({ ...FEATURE_REGISTRY[key], enabled: state[key] }));
  }

  async toggleFeature(input: FeatureToggleInput) {
    const tenantId = requireTenantId();
    const actor = requireContext().actor;
    await this.db.tenant.tenantFeature.upsert({
      where: { tenantId_key: { tenantId, key: input.key } },
      update: { enabled: input.enabled, updatedByActor: actor.type, updatedById: actor.id },
      create: { tenantId, key: input.key, enabled: input.enabled, updatedByActor: actor.type, updatedById: actor.id },
    });
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
    };
  }
}
