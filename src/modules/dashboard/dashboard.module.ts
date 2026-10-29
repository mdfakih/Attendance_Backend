import { Controller, Get, Module } from '@nestjs/common';
import { dashboardQuerySchema } from '@attendance/contracts';
import type { z } from 'zod';
import { RequirePermission, TenantApi } from '../../core/auth/decorators.js';
import { ZQuery } from '../../core/http/zod.js';
import { AttendanceModule } from '../attendance/attendance.module.js';
import { HousekeepingModule } from '../housekeeping/housekeeping.module.js';
import { DashboardService } from './dashboard.service.js';

@TenantApi()
@RequirePermission('DASHBOARD', 'view')
@Controller('v1/tenant/dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get('summary')
  summary(@ZQuery(dashboardQuerySchema) q: z.infer<typeof dashboardQuerySchema>) {
    return this.dashboard.summary(q);
  }

  @Get('live')
  live(@ZQuery(dashboardQuerySchema) q: z.infer<typeof dashboardQuerySchema>) {
    return this.dashboard.live(q);
  }

  @Get('map')
  map(@ZQuery(dashboardQuerySchema) q: z.infer<typeof dashboardQuerySchema>) {
    return this.dashboard.map(q);
  }
}

@Module({
  imports: [AttendanceModule, HousekeepingModule],
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}
