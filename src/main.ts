import { existsSync } from 'node:fs';
import { ConsoleLogger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { loadEnv } from './core/config/env.js';
import { contextMiddleware } from './core/context/context.middleware.js';

if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

async function bootstrap(): Promise<void> {
  const env = loadEnv();
  const { AppModule } = await import('./app.module.js');
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: new ConsoleLogger({ json: env.NODE_ENV === 'production', logLevels: ['log', 'warn', 'error', 'fatal'] }),
    bodyParser: true,
  });
  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(contextMiddleware);
  app.useBodyParser('json', { limit: '1mb' });
  app.enableCors({ origin: env.CORS_ORIGINS, credentials: true });
  app.enableShutdownHooks();
  await app.listen(env.PORT, '0.0.0.0');
}

await bootstrap();
