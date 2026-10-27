import { Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Put } from '@nestjs/common';
import {
  featureToggleSchema,
  inviteUserSchema,
  paySettingsSchema,
  roleSchema,
  tenantSettingsSchema,
  updateMembershipSchema,
} from '@attendance/contracts';
import type { z } from 'zod';
import { AdminOnly, AllowSuspended, RequirePermission, TenantApi } from '../../core/auth/decorators.js';
import { ZBody } from '../../core/http/zod.js';
import { CompanyService } from './company.service.js';
import { UsersService } from './users.service.js';

@TenantApi()
@Controller('v1/tenant')
export class CompanyController {
  constructor(
    private readonly company: CompanyService,
    private readonly users: UsersService,
  ) {}

  @Get('me')
  me() {
    return this.company.me();
  }

  @RequirePermission('SETTINGS', 'view')
  @Get('settings')
  settings() {
    return this.company.settings();
  }

  @RequirePermission('SETTINGS', 'edit')
  @Patch('settings')
  updateSettings(@ZBody(tenantSettingsSchema) body: z.infer<typeof tenantSettingsSchema>) {
    return this.company.updateSettings(body);
  }

  @RequirePermission('PAY', 'edit')
  @Put('settings/pay')
  updatePaySettings(@ZBody(paySettingsSchema) body: z.infer<typeof paySettingsSchema>) {
    return this.company.updatePaySettings(body);
  }

  @Get('features')
  features() {
    return this.company.features();
  }

  @AdminOnly()
  @Put('features')
  toggleFeature(@ZBody(featureToggleSchema) body: z.infer<typeof featureToggleSchema>) {
    return this.company.toggleFeature(body);
  }

  @AdminOnly()
  @AllowSuspended()
  @Get('billing')
  billing() {
    return this.company.subscription();
  }

  @AdminOnly()
  @Get('roles')
  roles() {
    return this.users.roles();
  }

  @AdminOnly()
  @Post('roles')
  createRole(@ZBody(roleSchema) body: z.infer<typeof roleSchema>) {
    return this.users.createRole(body);
  }

  @AdminOnly()
  @Put('roles/:id')
  updateRole(@Param('id', ParseUUIDPipe) id: string, @ZBody(roleSchema) body: z.infer<typeof roleSchema>) {
    return this.users.updateRole(id, body);
  }

  @AdminOnly()
  @Delete('roles/:id')
  async deleteRole(@Param('id', ParseUUIDPipe) id: string) {
    await this.users.deleteRole(id);
    return { ok: true };
  }

  @AdminOnly()
  @Get('users')
  listUsers() {
    return this.users.users();
  }

  @AdminOnly()
  @Post('users/invite')
  invite(@ZBody(inviteUserSchema) body: z.infer<typeof inviteUserSchema>) {
    return this.users.invite(body);
  }

  @AdminOnly()
  @Patch('users/:membershipId')
  updateUser(
    @Param('membershipId', ParseUUIDPipe) id: string,
    @ZBody(updateMembershipSchema) body: z.infer<typeof updateMembershipSchema>,
  ) {
    return this.users.updateMembership(id, body);
  }

  @AdminOnly()
  @Post('invitations/:id/resend')
  async resend(@Param('id', ParseUUIDPipe) id: string) {
    await this.users.resendInvite(id);
    return { ok: true };
  }

  @AdminOnly()
  @Post('invitations/:id/revoke')
  async revoke(@Param('id', ParseUUIDPipe) id: string) {
    await this.users.revokeInvite(id);
    return { ok: true };
  }
}
