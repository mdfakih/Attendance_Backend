import { Module } from '@nestjs/common';
import { AttendanceModule } from '../attendance/attendance.module.js';
import { EmployeesModule } from '../employees/employees.module.js';
import { HousekeepingModule } from '../housekeeping/housekeeping.module.js';
import { EmployeeSelfService } from './employee-self.service.js';
import { MobileAuthService } from './mobile-auth.service.js';
import { MobileAuthController, MobileController } from './mobile.controller.js';
import { PunchService } from './punch.service.js';

@Module({
  imports: [AttendanceModule, EmployeesModule, HousekeepingModule],
  controllers: [MobileAuthController, MobileController],
  providers: [MobileAuthService, PunchService, EmployeeSelfService],
})
export class MobileModule {}
