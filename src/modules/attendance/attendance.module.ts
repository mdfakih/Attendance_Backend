import { Module } from '@nestjs/common';
import { AttendanceDayService } from './attendance-day.service.js';
import { AttendanceMarkService } from './attendance-mark.service.js';
import { AttendanceQueryService } from './attendance-query.service.js';
import { AttendanceController } from './attendance.controller.js';
import { DayInputsLoader } from './day-inputs.loader.js';

@Module({
  controllers: [AttendanceController],
  providers: [DayInputsLoader, AttendanceDayService, AttendanceQueryService, AttendanceMarkService],
  exports: [DayInputsLoader, AttendanceDayService, AttendanceQueryService],
})
export class AttendanceModule {}
