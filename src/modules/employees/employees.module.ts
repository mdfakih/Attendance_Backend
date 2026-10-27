import { Module } from '@nestjs/common';
import { ActivationCodesService } from './activation-codes.service.js';
import { DevicesService } from './devices.service.js';
import { EmployeesController } from './employees.controller.js';
import { EmployeesService } from './employees.service.js';
import { ImportService } from './import.service.js';
import { SalaryService } from './salary.service.js';

@Module({
  controllers: [EmployeesController],
  providers: [EmployeesService, ActivationCodesService, DevicesService, ImportService, SalaryService],
  exports: [ActivationCodesService, EmployeesService],
})
export class EmployeesModule {}
