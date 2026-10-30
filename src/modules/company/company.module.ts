import { Module } from '@nestjs/common';
import { AttendanceModule } from '../attendance/attendance.module.js';
import { RolesModule } from '../roles/roles.module.js';
import { CompanyController } from './company.controller.js';
import { CompanyService } from './company.service.js';
import { UsersService } from './users.service.js';

@Module({
  imports: [AttendanceModule, RolesModule],
  controllers: [CompanyController],
  providers: [CompanyService, UsersService],
})
export class CompanyModule {}
