import { Module } from '@nestjs/common';
import { AttendanceModule } from '../attendance/attendance.module.js';
import { MobileEarningsController, PayController } from './pay.controller.js';
import { PayService } from './pay.service.js';

@Module({
  imports: [AttendanceModule],
  controllers: [PayController, MobileEarningsController],
  providers: [PayService],
  exports: [PayService],
})
export class PayModule {}
