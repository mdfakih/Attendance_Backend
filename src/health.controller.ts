import { Controller, Get, Inject } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { Public } from './core/auth/decorators.js';
import { PrismaService } from './core/database/prisma.service.js';
import { REDIS } from './core/redis/redis.module.js';

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

  @Public()
  @Get('ready')
  async ready() {
    await this.prisma.$queryRaw`SELECT 1`;
    await this.redis.ping();
    return { status: 'ok', db: 'up', redis: 'up' };
  }
}
