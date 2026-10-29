import { Controller, Get, Param, ParseUUIDPipe, Patch, Post, Put } from '@nestjs/common';
import {
  brandingSchema,
  createTenantSchema,
  isoDateSchema,
  loginSchema,
  paginationQuerySchema,
  planSchema,
  platformFeatureSchema,
  reasonSchema,
  recordPaymentSchema,
  refreshSchema,
  TENANT_STATUSES,
  tenantStatusChangeSchema,
  updateSubscriptionSchema,
  updateTenantSchema,
  emailSchema,
} from '@attendance/contracts';
import { z } from 'zod';
import { PlatformApi, PlatformRoles, Public } from '../../core/auth/decorators.js';
import { requirePlatform } from '../../core/context/request-context.js';
import { paged } from '../../core/http/envelope.js';
import { ZBody, ZQuery } from '../../core/http/zod.js';
import { BillingService } from './billing.service.js';
import { OnboardingService } from './onboarding.service.js';
import { PlatformAuthService } from './platform-auth.service.js';
import { TenantsService } from './tenants.service.js';

const tenantListSchema = paginationQuerySchema.extend({ status: z.enum(TENANT_STATUSES).optional() });
const chargeSchema = z.object({
  periodStart: isoDateSchema,
  periodEnd: isoDateSchema,
  billableEmployees: z.coerce.number().int().min(0).optional(),
  gstRate: z.coerce.number().min(0).max(28).optional(),
  invoiceNo: z.string().trim().max(40).optional(),
  notes: z.string().max(500).optional(),
});
const issueSchema = z.object({ dueDate: isoDateSchema.optional() });
const paymentSchema = recordPaymentSchema.extend({ chargeId: z.uuid().optional() });

@Controller('v1/platform/auth')
export class PlatformAuthController {
  constructor(private readonly auth: PlatformAuthService) {}

  @Public()
  @Post('login')
  login(@ZBody(loginSchema) body: z.infer<typeof loginSchema>) {
    return this.auth.login(body);
  }

  @Public()
  @Post('refresh')
  refresh(@ZBody(refreshSchema) body: z.infer<typeof refreshSchema>) {
    return this.auth.refreshTokens(body.refreshToken);
  }

  @Public()
  @Post('logout')
  async logout(@ZBody(refreshSchema) body: z.infer<typeof refreshSchema>) {
    await this.auth.logout(body.refreshToken);
    return { ok: true };
  }

  @PlatformApi()
  @Get('me')
  me() {
    return this.auth.me(requirePlatform().platformUserId);
  }
}

@PlatformApi()
@Controller('v1/platform')
export class PlatformController {
  constructor(
    private readonly tenants: TenantsService,
    private readonly onboarding: OnboardingService,
    private readonly billing: BillingService,
  ) {}

  @Get('overview')
  overview() {
    return this.billing.overview();
  }

  @Get('tenants')
  async listTenants(@ZQuery(tenantListSchema) query: z.infer<typeof tenantListSchema>) {
    const { items, total } = await this.tenants.list(query);
    return paged(items, { page: query.page, pageSize: query.pageSize, total });
  }

  @PlatformRoles('SUPERADMIN', 'SUPPORT')
  @Post('tenants')
  createTenant(@ZBody(createTenantSchema) body: z.infer<typeof createTenantSchema>) {
    return this.onboarding.onboard(body, requirePlatform().platformUserId);
  }

  @Get('tenants/:id')
  tenant(@Param('id', ParseUUIDPipe) id: string) {
    return this.tenants.detail(id);
  }

  @PlatformRoles('SUPERADMIN', 'SUPPORT')
  @Patch('tenants/:id')
  updateTenant(@Param('id', ParseUUIDPipe) id: string, @ZBody(updateTenantSchema) body: z.infer<typeof updateTenantSchema>) {
    return this.tenants.update(id, body);
  }

  @PlatformRoles('SUPERADMIN', 'FINANCE')
  @Post('tenants/:id/suspend')
  suspend(@Param('id', ParseUUIDPipe) id: string, @ZBody(tenantStatusChangeSchema) body: { reason: string }) {
    return this.tenants.setStatus(id, 'SUSPENDED', body.reason);
  }

  @PlatformRoles('SUPERADMIN', 'FINANCE')
  @Post('tenants/:id/reactivate')
  reactivate(@Param('id', ParseUUIDPipe) id: string, @ZBody(tenantStatusChangeSchema) body: { reason: string }) {
    return this.tenants.setStatus(id, 'ACTIVE', body.reason);
  }

  @PlatformRoles('SUPERADMIN', 'SUPPORT')
  @Post('tenants/:id/resend-invite')
  resendInvite(@Param('id', ParseUUIDPipe) id: string, @ZBody(z.object({ email: emailSchema })) body: { email: string }) {
    return this.tenants.resendAdminInvite(id, body.email);
  }

  @Get('tenants/:id/features')
  features(@Param('id', ParseUUIDPipe) id: string) {
    return this.tenants.features(id);
  }

  @PlatformRoles('SUPERADMIN', 'SUPPORT')
  @Put('tenants/:id/features')
  setFeature(@Param('id', ParseUUIDPipe) id: string, @ZBody(platformFeatureSchema) body: z.infer<typeof platformFeatureSchema>) {
    return this.tenants.setFeature(id, body);
  }

  @PlatformRoles('SUPERADMIN', 'SUPPORT')
  @Put('tenants/:id/branding')
  setBranding(@Param('id', ParseUUIDPipe) id: string, @ZBody(brandingSchema) body: z.infer<typeof brandingSchema>) {
    return this.tenants.setBranding(id, body);
  }

  @Get('tenants/:id/usage')
  usage(@Param('id', ParseUUIDPipe) id: string) {
    return this.tenants.usage(id);
  }

  @PlatformRoles('SUPERADMIN', 'FINANCE')
  @Patch('tenants/:id/subscription')
  updateSubscription(
    @Param('id', ParseUUIDPipe) id: string,
    @ZBody(updateSubscriptionSchema) body: z.infer<typeof updateSubscriptionSchema>,
  ) {
    return this.billing.updateSubscription(id, body);
  }

  @PlatformRoles('SUPERADMIN', 'FINANCE')
  @Post('tenants/:id/charges')
  createCharge(@Param('id', ParseUUIDPipe) id: string, @ZBody(chargeSchema) body: z.infer<typeof chargeSchema>) {
    return this.billing.createCharge(id, body);
  }

  @PlatformRoles('SUPERADMIN', 'FINANCE')
  @Post('charges/:id/issue')
  issueCharge(@Param('id', ParseUUIDPipe) id: string, @ZBody(issueSchema) body: z.infer<typeof issueSchema>) {
    return this.billing.issueCharge(id, body.dueDate);
  }

  @PlatformRoles('SUPERADMIN', 'FINANCE')
  @Post('charges/:id/void')
  voidCharge(@Param('id', ParseUUIDPipe) id: string, @ZBody(z.object({ reason: reasonSchema })) body: { reason: string }) {
    return this.billing.voidCharge(id, body.reason);
  }

  @PlatformRoles('SUPERADMIN', 'FINANCE')
  @Post('tenants/:id/payments')
  recordPayment(@Param('id', ParseUUIDPipe) id: string, @ZBody(paymentSchema) body: z.infer<typeof paymentSchema>) {
    return this.billing.recordPayment(id, body);
  }

  @Get('plans')
  plans() {
    return this.billing.listPlans();
  }

  @PlatformRoles('SUPERADMIN')
  @Post('plans')
  createPlan(@ZBody(planSchema) body: z.infer<typeof planSchema>) {
    return this.billing.createPlan(body);
  }

  @PlatformRoles('SUPERADMIN')
  @Patch('plans/:id')
  setPlanActive(@Param('id', ParseUUIDPipe) id: string, @ZBody(z.object({ active: z.boolean() })) body: { active: boolean }) {
    return this.billing.setPlanActive(id, body.active);
  }
}
