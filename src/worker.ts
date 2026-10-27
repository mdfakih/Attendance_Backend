import { existsSync } from 'node:fs';
import { ConsoleLogger, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { loadEnv } from './core/config/env.js';

if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

async function bootstrap(): Promise<void> {
  const env = loadEnv();
  const { WorkerModule } = await import('./worker.module.js');
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    logger: new ConsoleLogger({ json: env.NODE_ENV === 'production', logLevels: ['log', 'warn', 'error', 'fatal'] }),
  });
  app.enableShutdownHooks();
  new Logger('Worker').log('Worker process ready');
}

await bootstrap();
