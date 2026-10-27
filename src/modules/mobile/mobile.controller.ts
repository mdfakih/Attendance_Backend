import { Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
  bindingStatusSchema,
  consentAcceptSchema,
  employeeMonthQuerySchema,
  fcmTokenSchema,
  isoDateSchema,
  mobileActivateSchema,
  mobilePinResetSchema,
  mobileRefreshSchema,
  punchCommitSchema,
  punchIntentSchema,
  selfieUploadRequestSchema,
} from '@attendance/contracts';
import { z } from 'zod';
import { AllowWithoutConsent, EmployeeApi, Public } from '../../core/auth/decorators.js';
import { requireEmployee } from '../../core/context/request-context.js';
import { ZBody, ZQuery } from '../../core/http/zod.js';
import { EmployeeSelfService } from './employee-self.service.js';
import { MobileAuthService } from './mobile-auth.service.js';
import { PunchService } from './punch.service.js';

@Controller('v1/mobile/auth')
export class MobileAuthController {
  constructor(private readonly auth: MobileAuthService) {}

  @Public()
  @Post('nonce')
  nonce() {
    return this.auth.nonce();
  }

  @Public()
  @Post('activate')
  activate(@ZBody(mobileActivateSchema) body: z.infer<typeof mobileActivateSchema>) {
    return this.auth.activate(body);
  }

  @Public()
  @Post('binding-status')
  status(@ZBody(bindingStatusSchema) body: z.infer<typeof bindingStatusSchema>) {
    return this.auth.bindingStatus(body);
  }

  @Public()
  @Post('refresh')
  refresh(@ZBody(mobileRefreshSchema) body: z.infer<typeof mobileRefreshSchema>) {
    return this.auth.refreshTokens(body);
  }

  @Public()
  @Post('pin-reset')
  pinReset(@ZBody(mobilePinResetSchema) body: z.infer<typeof mobilePinResetSchema>) {
    return this.auth.pinReset(body);
  }
}

@EmployeeApi()
@Controller('v1/mobile')
export class MobileController {
  constructor(
    private readonly self: EmployeeSelfService,
    private readonly punch: PunchService,
    private readonly auth: MobileAuthService,
  ) {}

  @AllowWithoutConsent()
  @Get('me')
  me() {
    return this.self.me();
  }

  @AllowWithoutConsent()
  @Post('consent')
  consent(@ZBody(consentAcceptSchema) body: z.infer<typeof consentAcceptSchema>) {
    return this.self.acceptConsent(body);
  }

  @AllowWithoutConsent()
  @Post('device/fcm-token')
  async fcm(@ZBody(fcmTokenSchema) body: z.infer<typeof fcmTokenSchema>) {
    await this.auth.updateFcmToken(requireEmployee().bindingId, body.fcmToken);
    return { ok: true };
  }

  @Get('punch/context')
  context() {
    return this.punch.context();
  }

  @Post('punch/intents')
  intent(@ZBody(punchIntentSchema) body: z.infer<typeof punchIntentSchema>) {
    return this.punch.intent(body);
  }

  @Post('punch/selfie-upload')
  selfie(@ZBody(selfieUploadRequestSchema) body: z.infer<typeof selfieUploadRequestSchema>) {
    return this.punch.selfieUpload(body);
  }

  @Post('punches')
  commit(@ZBody(punchCommitSchema) body: z.infer<typeof punchCommitSchema>) {
    return this.punch.commit(body);
  }

  @Get('attendance/month')
  month(@ZQuery(employeeMonthQuerySchema) q: z.infer<typeof employeeMonthQuerySchema>) {
    return this.self.month(q.month);
  }

  @Get('attendance/days/:date')
  day(@Param('date') date: string) {
    return this.self.day(isoDateSchema.parse(date));
  }

  @Get('holidays')
  holidays(@Query('year') year?: string) {
    return this.self.holidays(z.coerce.number().int().min(2000).max(2100).catch(new Date().getFullYear()).parse(year));
  }

  @Get('notifications')
  notifications() {
    return this.self.notifications();
  }

  @Post('notifications/:id/read')
  async read(@Param('id', ParseUUIDPipe) id: string) {
    await this.self.markRead(id);
    return { ok: true };
  }
}
