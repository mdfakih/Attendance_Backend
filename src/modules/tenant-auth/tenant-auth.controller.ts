import { Controller, Get, Post, Query } from '@nestjs/common';
import {
  acceptInviteSchema,
  forgotPasswordSchema,
  loginSchema,
  refreshSchema,
  resetPasswordSchema,
} from '@attendance/contracts';
import { z } from 'zod';
import { Public, TenantApi } from '../../core/auth/decorators.js';
import { requireTenantUser } from '../../core/context/request-context.js';
import { ZBody } from '../../core/http/zod.js';
import { TenantAuthService } from './tenant-auth.service.js';

const selectSchema = z.object({ selectionToken: z.string().min(10).max(100), tenantId: z.uuid() });

@Controller('v1/tenant/auth')
export class TenantAuthController {
  constructor(private readonly auth: TenantAuthService) {}

  @Public()
  @Post('login')
  login(@ZBody(loginSchema) body: z.infer<typeof loginSchema>) {
    return this.auth.login(body);
  }

  @Public()
  @Post('select-company')
  select(@ZBody(selectSchema) body: z.infer<typeof selectSchema>) {
    return this.auth.selectCompany(body.selectionToken, body.tenantId);
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

  @Public()
  @Get('invitation')
  invitation(@Query('token') token: string) {
    return this.auth.inviteInfo(z.string().min(20).max(256).parse(token));
  }

  @Public()
  @Post('accept-invite')
  accept(@ZBody(acceptInviteSchema) body: z.infer<typeof acceptInviteSchema>) {
    return this.auth.acceptInvite(body);
  }

  @Public()
  @Post('forgot-password')
  async forgot(@ZBody(forgotPasswordSchema) body: z.infer<typeof forgotPasswordSchema>) {
    await this.auth.forgotPassword(body.email);
    return { ok: true };
  }

  @Public()
  @Post('reset-password')
  async reset(@ZBody(resetPasswordSchema) body: z.infer<typeof resetPasswordSchema>) {
    await this.auth.resetPassword(body.token, body.password);
    return { ok: true };
  }

  @TenantApi()
  @Get('companies')
  companies() {
    return this.auth.companies(requireTenantUser().userId);
  }

  @TenantApi()
  @Post('switch-company')
  switchCompany(@ZBody(z.object({ tenantId: z.uuid() })) body: { tenantId: string }) {
    return this.auth.switchCompany(requireTenantUser().userId, body.tenantId);
  }
}
