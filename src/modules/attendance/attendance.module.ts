import { Module } from '@nestjs/common';
import { AttendanceDayService } from './attendance-day.service.js';
import { AttendanceMarkService } from './attendance-mark.service.js';
import { AttendanceQueryService } from './attendance-query.service.js';
import { AttendanceSettleService } from './attendance-settle.service.js';
import { AttendanceController } from './attendance.controller.js';
import { DayInputsLoader } from './day-inputs.loader.js';
import { RegularizationService } from './regularization.service.js';

@Module({
  controllers: [AttendanceController],
  providers: [DayInputsLoader, AttendanceDayService, AttendanceSettleService, AttendanceQueryService, AttendanceMarkService, RegularizationService],
  exports: [DayInputsLoader, AttendanceDayService, AttendanceSettleService, AttendanceQueryService, RegularizationService],
})
export class AttendanceModule {}
