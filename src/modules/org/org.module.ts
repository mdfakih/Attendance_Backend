import { Module } from '@nestjs/common';
import { AttendanceModule } from '../attendance/attendance.module.js';
import { OrgController } from './org.controller.js';
import { OrgService } from './org.service.js';

@Module({
  imports: [AttendanceModule],
  controllers: [OrgController],
  providers: [OrgService],
})
export class OrgModule {}
