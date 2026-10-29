import { Controller, Get, Inject } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { Public } from './core/auth/decorators.js';
import { PrismaService } from './core/database/prisma.service.js';
import { AppError } from './core/http/app-error.js';
import { REDIS } from './core/redis/redis.module.js';

/** Longer than a Neon compute wake-up, shorter than a load balancer's health timeout. */
const CHECK_TIMEOUT_MS = 8000;

/** Runs one dependency check; a failure or a hang past the timeout is reported as down. */
export async function probe(check: () => Promise<unknown>, timeoutMs = CHECK_TIMEOUT_MS): Promise<'up' | 'down'> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
  });
  try {
    await Promise.race([check(), timeout]);
    return 'up';
  } catch {
    return 'down';
  } finally {
    clearTimeout(timer);
  }
}

@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  @Public()
  @Get('live')
  live() {
    return { status: 'ok' };
  }

  /** Checks the database and Redis in parallel and names the one that is down. */
  @Public()
  @Get('ready')
  async ready() {
    const [db, redis] = await Promise.all([probe(() => this.prisma.$queryRaw`SELECT 1`), probe(() => this.redis.ping())]);
    if (db === 'down' || redis === 'down') {
      throw new AppError('INTERNAL_ERROR', 'A dependency is not reachable.', { db, redis });
    }
    return { status: 'ok', db, redis };
  }
}
