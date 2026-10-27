import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { AccessGuard } from './core/auth/access.guard.js';
import { AuthGuard } from './core/auth/auth.guard.js';
import { CoreModule } from './core/core.module.js';
import { EnvelopeInterceptor } from './core/http/envelope.interceptor.js';
import { AllExceptionsFilter } from './core/http/exception.filter.js';
import { HealthController } from './health.controller.js';
import { AttendanceModule } from './modules/attendance/attendance.module.js';
import { CompanyModule } from './modules/company/company.module.js';
import { DashboardModule } from './modules/dashboard/dashboard.module.js';
import { EmployeesModule } from './modules/employees/employees.module.js';
import { ExportsModule } from './modules/exports/exports.module.js';
import { LeaveModule } from './modules/leave/leave.module.js';
import { MobileModule } from './modules/mobile/mobile.module.js';
import { PayModule } from './modules/pay/pay.module.js';
import { OrgModule } from './modules/org/org.module.js';
import { PlatformModule } from './modules/platform/platform.module.js';
import { TenantAuthModule } from './modules/tenant-auth/tenant-auth.module.js';
import { TimeModule } from './modules/time/time.module.js';

@Module({
  imports: [
    CoreModule,
    PlatformModule,
    TenantAuthModule,
    CompanyModule,
    OrgModule,
    TimeModule,
    EmployeesModule,
    AttendanceModule,
    MobileModule,
    LeaveModule,
    PayModule,
    DashboardModule,
    ExportsModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: AccessGuard },
    { provide: APP_INTERCEPTOR, useClass: EnvelopeInterceptor },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
