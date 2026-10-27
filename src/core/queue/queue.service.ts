import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { type JobsOptions, Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { REDIS } from '../redis/redis.module.js';
import { QUEUE, type QueueName } from './queues.js';

const DEFAULT_OPTS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 2000 },
  removeOnComplete: { age: 3600, count: 1000 },
  removeOnFail: { age: 7 * 86400 },
};

/** Producer side of BullMQ. Consumers live in the worker process. */
@Injectable()
export class QueueService implements OnModuleDestroy {
  private readonly queues: ReadonlyMap<QueueName, Queue>;

  constructor(@Inject(REDIS) redis: Redis) {
    this.queues = new Map(
      Object.values(QUEUE).map((name) => [name, new Queue(name, { connection: redis, defaultJobOptions: DEFAULT_OPTS })]),
    );
  }

  queue(name: QueueName): Queue {
    const queue = this.queues.get(name);
    if (!queue) {
      throw new Error(`Unknown queue ${name}`);
    }
    return queue;
  }

  async add<T extends object>(name: QueueName, jobName: string, data: T, opts: JobsOptions = {}): Promise<void> {
    await this.queue(name).add(jobName, data, opts);
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all([...this.queues.values()].map((q) => q.close()));
  }
}
