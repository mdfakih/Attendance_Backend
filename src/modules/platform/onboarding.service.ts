import { Inject, Injectable } from '@nestjs/common';
import { AVAILABLE_PAYROLL_TIERS, type CreateTenantInput, type PermissionSet, type PayrollTier } from '@attendance/contracts';
import { AuditService } from '../../core/audit/audit.service.js';
import { ENV, type Env } from '../../core/config/env.js';
import { randomToken, sha256Hex } from '../../core/crypto/crypto.util.js';
import { DbService, type PlatformTx } from '../../core/database/db.service.js';
import { AppError } from '../../core/http/app-error.js';
import { QUEUE } from '../../core/queue/queues.js';
import { QueueService } from '../../core/queue/queue.service.js';
import { addDays, localDateOf, toDbDate } from '../../engines/time/dates.js';

export const DEFAULT_MANAGER_PERMISSIONS: PermissionSet = {
  DASHBOARD: ['view'],
  EMPLOYEES: ['view'],
  ATTENDANCE: ['view', 'export'],
  LEAVE: ['view', 'edit'],
  REPORTS: ['view', 'export'],
};

const INVITE_TTL_DAYS = 7;

export function assertTierAvailable(tier: PayrollTier): void {
  if (!AVAILABLE_PAYROLL_TIERS.includes(tier)) {
    throw new AppError('PAYROLL_TIER_UNAVAILABLE');
  }
}

export interface OnboardResult {
  readonly tenantId: string;
  readonly inviteLink: string;
}

/** Creates a tenant with sensible defaults so the first Admin can start immediately. */
@Injectable()
export class OnboardingService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly queues: QueueService,
  ) {}

  async onboard(input: CreateTenantInput, platformUserId: string): Promise<OnboardResult> {
    assertTierAvailable(input.payrollTier);
    const plan = await this.db.platform.plan.findFirst({ where: { id: input.planId, active: true } });
    if (!plan) {
      throw new AppError('VALIDATION_FAILED', 'Choose an active plan.');
    }
    const token = randomToken(32);
    const tenantId = await this.db.platform.$transaction(async (tx) => {
      const tenant = await tx.tenant.create({
        data: {
          slug: input.slug,
          legalName: input.legalName,
          displayName: input.displayName,
          gstin: input.gstin,
          stateCode: input.stateCode,
          billingEmail: input.billingEmail,
          timezone: input.timezone,
          payrollTier: input.payrollTier,
          employeeCap: input.employeeCap ?? plan.defaultEmployeeCap,
          createdById: platformUserId,
        },
      });
      await this.seedDefaults(tx, tenant.id, input);
      await this.createSubscription(tx, tenant.id, plan.id, input.trialDays, input.timezone, platformUserId);
      await this.inviteFirstAdmin(tx, tenant.id, input.admin, token);
      await this.audit.record(
        { action: 'tenant.create', entityType: 'tenant', entityId: tenant.id, after: { slug: tenant.slug, plan: plan.code } },
        tx,
      );
      return tenant.id;
    });
    const inviteLink = `${this.env.WEB_APP_URL}/accept-invite?token=${token}`;
    await this.queues.add(QUEUE.NOTIFY, 'email', {
      tenantId,
      to: input.admin.email,
      subject: `You're invited to manage ${input.displayName} attendance`,
      text: `Hello ${input.admin.fullName},\n\nSet up your Admin account here (valid for ${INVITE_TTL_DAYS} days):\n${inviteLink}\n`,
    });
    return { tenantId, inviteLink };
  }

  private async seedDefaults(tx: PlatformTx, tenantId: string, input: CreateTenantInput): Promise<void> {
    const policy = await tx.attendancePolicy.create({ data: { tenantId, name: 'Standard' } });
    const shift = await tx.shift.create({
      data: {
        tenantId,
        name: 'General',
        code: 'GEN',
        startTime: '09:00',
        endTime: '18:00',
        dutyMinutes: 480,
        unpaidBreakMinutes: 60,
        policyId: policy.id,
      },
    });
    const pattern = await tx.weeklyOffPattern.create({
      data: { tenantId, name: 'Sundays off', rules: [{ dow: 0, weeks: 'ALL' }] },
    });
    const calendar = await tx.holidayCalendar.create({ data: { tenantId, name: 'Default', isDefault: true } });
    await tx.branch.create({
      data: {
        tenantId,
        name: 'Head office',
        code: 'HO',
        stateCode: input.stateCode,
        holidayCalendarId: calendar.id,
        weeklyOffPatternId: pattern.id,
        defaultShiftId: shift.id,
      },
    });
    await tx.tenantSettings.create({
      data: { tenantId, defaultPolicyId: policy.id, defaultCalendarId: calendar.id, defaultPatternId: pattern.id },
    });
    await tx.role.createMany({
      data: [
        { tenantId, name: 'Admin', kind: 'ADMIN', isSystem: true, description: 'Full access', permissions: {} },
        {
          tenantId,
          name: 'Manager',
          kind: 'MANAGER',
          description: 'Default manager access; edit to grant more modules',
          permissions: DEFAULT_MANAGER_PERMISSIONS,
        },
      ],
    });
    await tx.leaveType.createMany({
      data: [
        { tenantId, code: 'CL', name: 'Casual leave', isPaid: true, accrualMode: 'YEARLY_ACCRUAL', annualQuota: 12, carryForwardCap: 0 },
        { tenantId, code: 'SL', name: 'Sick leave', isPaid: true, accrualMode: 'YEARLY_ACCRUAL', annualQuota: 6, carryForwardCap: 0 },
        { tenantId, code: 'LOP', name: 'Leave without pay', isPaid: false, accrualMode: 'NONE', maxNegativeBalance: 366 },
      ],
    });
  }

  private async createSubscription(
    tx: PlatformTx,
    tenantId: string,
    planId: string,
    trialDays: number,
    timezone: string,
    platformUserId: string,
  ): Promise<void> {
    const today = localDateOf(new Date(), timezone);
    const end = addDays(today, Math.max(trialDays, 1) - 1);
    const subscription = await tx.subscription.create({
      data: {
        tenantId,
        planId,
        status: trialDays > 0 ? 'TRIALING' : 'ACTIVE',
        currentPeriodStart: toDbDate(today),
        currentPeriodEnd: toDbDate(end),
        trialEndsAt: trialDays > 0 ? toDbDate(end) : null,
      },
    });
    await tx.subscriptionEvent.create({
      data: {
        tenantId,
        subscriptionId: subscription.id,
        eventType: 'CREATED',
        toStatus: subscription.status,
        actorType: 'PLATFORM_USER',
        actorId: platformUserId,
      },
    });
  }

  private async inviteFirstAdmin(
    tx: PlatformTx,
    tenantId: string,
    admin: CreateTenantInput['admin'],
    token: string,
  ): Promise<void> {
    const adminRole = await tx.role.findFirstOrThrow({ where: { tenantId, kind: 'ADMIN' } });
    await tx.user.upsert({
      where: { email: admin.email },
      update: {},
      create: { email: admin.email, fullName: admin.fullName },
    });
    await tx.userInvitation.create({
      data: {
        tenantId,
        email: admin.email,
        fullName: admin.fullName,
        roleId: adminRole.id,
        tokenHash: sha256Hex(token),
        expiresAt: new Date(Date.now() + INVITE_TTL_DAYS * 86_400_000),
      },
    });
  }
}
