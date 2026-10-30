import { Module } from '@nestjs/common';
import { HousekeepingModule } from '../housekeeping/housekeeping.module.js';
import { RolesModule } from '../roles/roles.module.js';
import { BillingService } from './billing.service.js';
import { OnboardingService } from './onboarding.service.js';
import { PlatformAuthService } from './platform-auth.service.js';
import { PlatformAuthController, PlatformController } from './platform.controller.js';
import { TenantsService } from './tenants.service.js';

@Module({
  imports: [HousekeepingModule, RolesModule],
  controllers: [PlatformAuthController, PlatformController],
  providers: [PlatformAuthService, TenantsService, OnboardingService, BillingService],
})
export class PlatformModule {}
