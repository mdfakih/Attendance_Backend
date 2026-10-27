import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import type { AuthRealm } from '@attendance/contracts';
import type { RefreshToken } from '../../generated/prisma/client.js';
import { randomToken, sha256Hex } from '../crypto/crypto.util.js';
import { DbService, type PlatformTx } from '../database/db.service.js';
import { AppError } from '../http/app-error.js';

export interface IssueRefreshInput {
  readonly realm: AuthRealm;
  readonly subjectId: string;
  readonly tenantId?: string | null;
  readonly bindingId?: string | null;
  readonly familyId?: string;
  readonly parentId?: string | null;
  readonly ttlDays: number;
  readonly absoluteExpiresAt?: Date | null;
  readonly ip?: string;
  readonly userAgent?: string;
}

export interface RotatedRefresh {
  readonly previous: RefreshToken;
  readonly token: string;
}

const DAY_MS = 86_400_000;

/** Opaque rotating refresh tokens with reuse detection (a reused token revokes its family). */
@Injectable()
export class RefreshTokenService {
  private readonly logger = new Logger(RefreshTokenService.name);

  constructor(private readonly db: DbService) {}

  async issue(input: IssueRefreshInput, tx?: PlatformTx): Promise<string> {
    const client = tx ?? this.db.platform;
    const token = randomToken(32);
    const slidingExpiry = new Date(Date.now() + input.ttlDays * DAY_MS);
    const expiresAt =
      input.absoluteExpiresAt && input.absoluteExpiresAt < slidingExpiry ? input.absoluteExpiresAt : slidingExpiry;
    await client.refreshToken.create({
      data: {
        realm: input.realm,
        subjectId: input.subjectId,
        tenantId: input.tenantId ?? null,
        bindingId: input.bindingId ?? null,
        familyId: input.familyId ?? randomUUID(),
        parentId: input.parentId ?? null,
        tokenHash: sha256Hex(token),
        expiresAt,
        absoluteExpiresAt: input.absoluteExpiresAt ?? null,
        ip: input.ip,
        userAgent: input.userAgent?.slice(0, 300),
      },
    });
    return token;
  }

  /** Validates without consuming (used before checking device signatures). */
  async peek(realm: AuthRealm, token: string): Promise<RefreshToken> {
    const record = await this.db.platform.refreshToken.findUnique({ where: { tokenHash: sha256Hex(token) } });
    if (!record || record.realm !== realm || record.revokedAt || record.expiresAt < new Date()) {
      throw new AppError('UNAUTHENTICATED');
    }
    return record;
  }

  async rotate(realm: AuthRealm, token: string, ttlDays: number): Promise<RotatedRefresh> {
    const record = await this.db.platform.refreshToken.findUnique({ where: { tokenHash: sha256Hex(token) } });
    if (!record || record.realm !== realm) {
      throw new AppError('UNAUTHENTICATED');
    }
    if (record.usedAt || record.revokedAt) {
      await this.revokeFamily(record.familyId, 'REUSE_DETECTED');
      this.logger.warn({ familyId: record.familyId, realm }, 'Refresh token reuse detected; family revoked');
      throw new AppError('UNAUTHENTICATED');
    }
    if (record.expiresAt < new Date()) {
      throw new AppError('TOKEN_EXPIRED');
    }
    const claimed = await this.db.platform.refreshToken.updateMany({
      where: { id: record.id, usedAt: null, revokedAt: null },
      data: { usedAt: new Date() },
    });
    if (claimed.count !== 1) {
      await this.revokeFamily(record.familyId, 'REUSE_DETECTED');
      throw new AppError('UNAUTHENTICATED');
    }
    const next = await this.issue({
      realm,
      subjectId: record.subjectId,
      tenantId: record.tenantId,
      bindingId: record.bindingId,
      familyId: record.familyId,
      parentId: record.id,
      ttlDays,
      absoluteExpiresAt: record.absoluteExpiresAt,
    });
    return { previous: record, token: next };
  }

  async revokeFamily(familyId: string, reason: string): Promise<void> {
    await this.db.platform.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: reason },
    });
  }

  async revokeBySubject(realm: AuthRealm, subjectId: string, reason: string, tx?: PlatformTx): Promise<void> {
    const client = tx ?? this.db.platform;
    await client.refreshToken.updateMany({
      where: { realm, subjectId, revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: reason },
    });
  }

  async revokeByBinding(bindingId: string, reason: string, tx?: PlatformTx): Promise<void> {
    const client = tx ?? this.db.platform;
    await client.refreshToken.updateMany({
      where: { bindingId, revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: reason },
    });
  }
}
