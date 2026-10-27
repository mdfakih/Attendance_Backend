import { Module } from '@nestjs/common';
import { CoreModule } from './core/core.module.js';
import { AttendanceModule } from './modules/attendance/attendance.module.js';
import { EmployeesModule } from './modules/employees/employees.module.js';
import { ExportsModule } from './modules/exports/exports.module.js';
import { LeaveModule } from './modules/leave/leave.module.js';
import { PayModule } from './modules/pay/pay.module.js';
import { AttendanceProcessor } from './worker/attendance.processor.js';
import { MaintenanceProcessor } from './worker/maintenance.processor.js';
import { NotifyProcessor } from './worker/notify.processor.js';
import { PayProcessor } from './worker/pay.processor.js';
import { WorkerService } from './worker/worker.service.js';

/** Background process: consumes queues and runs schedulers. No HTTP. */
@Module({
  imports: [CoreModule, AttendanceModule, PayModule, LeaveModule, ExportsModule, EmployeesModule],
  providers: [AttendanceProcessor, PayProcessor, NotifyProcessor, MaintenanceProcessor, WorkerService],
})
export class WorkerModule {}
