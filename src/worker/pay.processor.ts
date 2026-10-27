import { Injectable, Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { runAsTenant } from '../core/context/request-context.js';
import type { RecomputePayJob } from '../core/queue/queues.js';
import { PayService } from '../modules/pay/pay.service.js';

@Injectable()
export class PayProcessor {
  private readonly logger = new Logger(PayProcessor.name);

  constructor(private readonly pay: PayService) {}

  async handle(job: Job): Promise<void> {
    const data = job.data as RecomputePayJob & { month: string };
    switch (job.name) {
      case 'recompute-employee':
        return runAsTenant(data.tenantId, async () => {
          await this.pay.recomputeEmployeeMonth(data.employeeId, data.month);
        });
      case 'recompute-month':
        return runAsTenant(data.tenantId, async () => {
          await this.pay.recomputeTenantMonth(data.month);
        });
      default:
        this.logger.warn(`Unknown pay job ${job.name}`);
    }
  }
}
