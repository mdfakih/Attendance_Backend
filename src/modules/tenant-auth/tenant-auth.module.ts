import { Module } from '@nestjs/common';
import { TenantAuthController } from './tenant-auth.controller.js';
import { TenantAuthService } from './tenant-auth.service.js';

@Module({
  controllers: [TenantAuthController],
  providers: [TenantAuthService],
})
export class TenantAuthModule {}
