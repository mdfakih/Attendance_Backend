import { Module } from '@nestjs/common';
import { AttendanceModule } from '../attendance/attendance.module.js';
import { LeaveModule } from '../leave/leave.module.js';
import { HousekeepingService } from './housekeeping.service.js';

@Module({
  imports: [AttendanceModule, LeaveModule],
  providers: [HousekeepingService],
  exports: [HousekeepingService],
})
export class HousekeepingModule {}
