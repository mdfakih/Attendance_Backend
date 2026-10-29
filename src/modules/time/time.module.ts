import { Module } from '@nestjs/common';
import { AttendanceModule } from '../attendance/attendance.module.js';
import { TimeController } from './time.controller.js';
import { TimeService } from './time.service.js';

@Module({
  imports: [AttendanceModule],
  controllers: [TimeController],
  providers: [TimeService],
})
export class TimeModule {}
