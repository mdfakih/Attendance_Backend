import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit/audit.service.js';
import { PasswordService } from './auth/password.service.js';
import { PrincipalService } from './auth/principal.service.js';
import { RefreshTokenService } from './auth/refresh-token.service.js';
import { TokenService } from './auth/token.service.js';
import { ConfigModule } from './config/config.module.js';
import { DatabaseModule } from './database/database.module.js';
import { MailService } from './notify/mail.service.js';
import { NotifyService } from './notify/notify.service.js';
import { PushService } from './notify/push.service.js';
import { CacheService } from './redis/cache.service.js';
import { RedisModule } from './redis/redis.module.js';
import { StorageService } from './storage/storage.service.js';

const SERVICES = [
  AuditService,
  CacheService,
  MailService,
  NotifyService,
  PasswordService,
  PrincipalService,
  PushService,
  RefreshTokenService,
  StorageService,
  TokenService,
];

/** Cross-cutting infrastructure shared by all API modules. */
@Global()
@Module({
  imports: [ConfigModule, DatabaseModule, RedisModule],
  providers: SERVICES,
  exports: [ConfigModule, DatabaseModule, RedisModule, ...SERVICES],
})
export class CoreModule {}
