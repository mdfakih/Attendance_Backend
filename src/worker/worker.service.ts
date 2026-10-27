import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { type Job, Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import { runAsTenant } from '../core/context/request-context.js';
import { QUEUE, type ExportJobData, type QueueName } from '../core/queue/queues.js';
import { QueueService } from '../core/queue/queue.service.js';
import { REDIS } from '../core/redis/redis.module.js';
import { ExportsService, type ScopeSnapshot } from '../modules/exports/exports.service.js';
import { DbService } from '../core/database/db.service.js';
import { AttendanceProcessor } from './attendance.processor.js';
import { MaintenanceProcessor } from './maintenance.processor.js';
import { NotifyProcessor } from './notify.processor.js';
import { PayProcessor } from './pay.processor.js';

const CONCURRENCY: Readonly<Record<QueueName, number>> = {
  attendance: 8,
  pay: 4,
  exports: 2,
  notify: 8,
  maintenance: 1,
};

/** Starts one BullMQ worker per queue and registers recurring schedulers. */
@Injectable()
export class WorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WorkerService.name);
  private workers: Worker[] = [];

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    private readonly queues: QueueService,
    private readonly db: DbService,
    private readonly attendance: AttendanceProcessor,
    private readonly pay: PayProcessor,
    private readonly notify: NotifyProcessor,
    private readonly maintenance: MaintenanceProcessor,
    private readonly exports: ExportsService,
  ) {}

  async onModuleInit(): Promise<void> {
    const handlers: Record<QueueName, (job: Job) => Promise<void>> = {
      attendance: (job) => this.attendance.handle(job),
      pay: (job) => this.pay.handle(job),
      notify: (job) => this.notify.handle(job),
      maintenance: (job) => this.maintenance.handle(job),
      exports: (job) => this.runExport(job.data as ExportJobData),
    };
    this.workers = (Object.values(QUEUE) as QueueName[]).map((name) => {
      const worker = new Worker(name, handlers[name], { connection: this.redis, concurrency: CONCURRENCY[name] });
      worker.on('failed', (job, error) => this.logger.error(`${name}/${job?.name ?? '?'} failed: ${error.message}`));
      return worker;
    });
    await this.registerSchedulers();
    this.logger.log(`Workers started for ${this.workers.length} queues`);
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all(this.workers.map((w) => w.close()));
  }

  private async registerSchedulers(): Promise<void> {
    const attendance = this.queues.queue(QUEUE.ATTENDANCE);
    await attendance.upsertJobScheduler('tick', { every: 5 * 60_000 }, { name: 'tick', data: {} });
    await attendance.upsertJobScheduler('ensure-days', { pattern: '5 * * * *' }, { name: 'ensure-days', data: {} });
    const maintenance = this.queues.queue(QUEUE.MAINTENANCE);
    await maintenance.upsertJobScheduler('daily', { pattern: '0 21 * * *' }, { name: 'daily', data: {} }); // 02:30 IST
  }

  private async runExport(data: ExportJobData): Promise<void> {
    const job = await this.db.platform.exportJob.findUnique({ where: { id: data.exportJobId } });
    if (!job) return;
    const scope = (job.params as { scope?: ScopeSnapshot }).scope ?? { roleKind: 'ADMIN', branchIds: [], departmentIds: [] };
    await runAsTenant(data.tenantId, () => this.exports.run(data.exportJobId), {
      tenantUser: { membershipId: job.requestedById, userId: '', roleId: '', roleKind: scope.roleKind, permissions: {}, branchIds: scope.branchIds, departmentIds: scope.departmentIds },
    });
  }
}
