import { Module } from '@nestjs/common';
import { AttendanceModule } from '../attendance/attendance.module.js';
import { LeaveController, MobileLeaveController } from './leave.controller.js';
import { LeaveService } from './leave.service.js';

@Module({
  imports: [AttendanceModule],
  controllers: [LeaveController, MobileLeaveController],
  providers: [LeaveService],
  exports: [LeaveService],
})
export class LeaveModule {}
