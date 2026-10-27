import { Inject, Injectable } from '@nestjs/common';
import type { LoginInput, PlatformRole, TokenPair } from '@attendance/contracts';
import { AuditService } from '../../core/audit/audit.service.js';
import { PasswordService } from '../../core/auth/password.service.js';
import { RefreshTokenService } from '../../core/auth/refresh-token.service.js';
import { TokenService } from '../../core/auth/token.service.js';
import { currentContext } from '../../core/context/request-context.js';
import { ENV, type Env } from '../../core/config/env.js';
import { decryptString } from '../../core/crypto/crypto.util.js';
import { verifyTotp } from '../../core/crypto/totp.js';
import { DbService } from '../../core/database/db.service.js';
import { AppError } from '../../core/http/app-error.js';
import { CacheService } from '../../core/redis/cache.service.js';

const MAX_FAILURES = 10;
const LOCK_MINUTES = 30;
const SESSION_HOURS = 12;

@Injectable()
export class PlatformAuthService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly db: DbService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly refresh: RefreshTokenService,
    private readonly cache: CacheService,
    private readonly audit: AuditService,
  ) {}

  async login(input: LoginInput): Promise<TokenPair> {
    const ip = currentContext()?.ip ?? 'unknown';
    await this.cache.limit(`plogin:${input.email}:${ip}`, 5, 15 * 60);
    const user = await this.db.platform.platformUser.findUnique({ where: { email: input.email } });
    const passwordOk = await this.passwords.verify(user?.passwordHash, input.password);
    if (!user || user.status !== 'ACTIVE') {
      throw new AppError('INVALID_CREDENTIALS');
    }
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new AppError('ACCOUNT_LOCKED');
    }
    if (!passwordOk) {
      await this.registerFailure(user.id, user.failedLogins + 1);
      throw new AppError('INVALID_CREDENTIALS');
    }
    if (user.mfaEnabled && user.mfaSecretEnc) {
      if (!input.totp) {
        throw new AppError('MFA_REQUIRED');
      }
      if (!verifyTotp(decryptString(this.env.CODE_ENC_KEY, user.mfaSecretEnc), input.totp)) {
        await this.registerFailure(user.id, user.failedLogins + 1);
        throw new AppError('INVALID_CREDENTIALS');
      }
    }
    await this.db.platform.platformUser.update({
      where: { id: user.id },
      data: { failedLogins: 0, lockedUntil: null, lastLoginAt: new Date() },
    });
    await this.audit.record({ action: 'platform.auth.login', entityType: 'platform_user', entityId: user.id, tenantId: null });
    return this.issue(user.id, user.role);
  }

  async refreshTokens(token: string): Promise<TokenPair> {
    const rotated = await this.refresh.rotate('PLATFORM_USER', token, 1);
    const user = await this.db.platform.platformUser.findUnique({ where: { id: rotated.previous.subjectId } });
    if (!user || user.status !== 'ACTIVE') {
      throw new AppError('UNAUTHENTICATED');
    }
    const access = await this.tokens.sign('PLATFORM_USER', { sub: user.id, role: user.role });
    return { accessToken: access.token, refreshToken: rotated.token, accessExpiresAt: access.expiresAt.toISOString() };
  }

  async logout(token: string): Promise<void> {
    const record = await this.refresh.peek('PLATFORM_USER', token).catch(() => null);
    if (record) {
      await this.refresh.revokeFamily(record.familyId, 'LOGOUT');
    }
  }

  async me(platformUserId: string) {
    const user = await this.db.platform.platformUser.findUniqueOrThrow({ where: { id: platformUserId } });
    return { id: user.id, email: user.email, fullName: user.fullName, role: user.role, mfaEnabled: user.mfaEnabled };
  }

  private async issue(userId: string, role: PlatformRole): Promise<TokenPair> {
    const access = await this.tokens.sign('PLATFORM_USER', { sub: userId, role });
    const refreshToken = await this.refresh.issue({
      realm: 'PLATFORM_USER',
      subjectId: userId,
      ttlDays: 1,
      absoluteExpiresAt: new Date(Date.now() + SESSION_HOURS * 3_600_000),
      ip: currentContext()?.ip,
      userAgent: currentContext()?.userAgent,
    });
    return { accessToken: access.token, refreshToken, accessExpiresAt: access.expiresAt.toISOString() };
  }

  private async registerFailure(userId: string, failures: number): Promise<void> {
    await this.db.platform.platformUser.update({
      where: { id: userId },
      data: {
        failedLogins: failures,
        lockedUntil: failures >= MAX_FAILURES ? new Date(Date.now() + LOCK_MINUTES * 60_000) : undefined,
      },
    });
  }
}
