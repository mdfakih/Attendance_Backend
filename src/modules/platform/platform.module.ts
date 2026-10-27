import { Module } from '@nestjs/common';
import { BillingService } from './billing.service.js';
import { OnboardingService } from './onboarding.service.js';
import { PlatformAuthService } from './platform-auth.service.js';
import { PlatformAuthController, PlatformController } from './platform.controller.js';
import { TenantsService } from './tenants.service.js';

@Module({
  controllers: [PlatformAuthController, PlatformController],
  providers: [PlatformAuthService, TenantsService, OnboardingService, BillingService],
})
export class PlatformModule {}
