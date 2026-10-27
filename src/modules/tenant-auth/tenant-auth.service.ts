import { Inject, Injectable } from '@nestjs/common';
import type { AcceptInviteInput, LoginInput, TokenPair } from '@attendance/contracts';
import { AuditService } from '../../core/audit/audit.service.js';
import { PasswordService } from '../../core/auth/password.service.js';
import { RefreshTokenService } from '../../core/auth/refresh-token.service.js';
import { TokenService } from '../../core/auth/token.service.js';
import { ENV, type Env } from '../../core/config/env.js';
import { currentContext } from '../../core/context/request-context.js';
import { decryptString, randomToken, sha256Hex } from '../../core/crypto/crypto.util.js';
import { verifyTotp } from '../../core/crypto/totp.js';
import { DbService } from '../../core/database/db.service.js';
import { AppError } from '../../core/http/app-error.js';
import { QUEUE } from '../../core/queue/queues.js';
import { QueueService } from '../../core/queue/queue.service.js';
import { CacheService } from '../../core/redis/cache.service.js';

const MAX_FAILURES = 10;
const LOCK_MINUTES = 30;
const REFRESH_TTL_DAYS = 14;
const ABSOLUTE_DAYS = 30;
const SELECTION_TTL_SEC = 300;

export interface CompanyChoice {
  readonly tenantId: string;
  readonly name: string;
  readonly role: string;
}

export type LoginOutcome =
  | ({ readonly kind: 'TOKENS' } & TokenPair)
  | { readonly kind: 'SELECT_COMPANY'; readonly selectionToken: string; readonly companies: readonly CompanyChoice[] };

@Injectable()
export class TenantAuthService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly db: DbService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly refresh: RefreshTokenService,
    private readonly cache: CacheService,
    private readonly audit: AuditService,
    private readonly queues: QueueService,
  ) {}

  async login(input: LoginInput): Promise<LoginOutcome> {
    await this.cache.limit(`tlogin:${input.email}:${currentContext()?.ip ?? ''}`, 5, 15 * 60);
    const user = await this.db.platform.user.findUnique({ where: { email: input.email } });
    const ok = await this.passwords.verify(user?.passwordHash, input.password);
    if (!user || user.status !== 'ACTIVE' || !user.passwordHash) {
      throw new AppError('INVALID_CREDENTIALS');
    }
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new AppError('ACCOUNT_LOCKED');
    }
    if (!ok) {
      await this.registerFailure(user.id, user.failedLogins + 1);
      throw new AppError('INVALID_CREDENTIALS');
    }
    if (user.mfaEnabled && user.mfaSecretEnc) {
      if (!input.totp) throw new AppError('MFA_REQUIRED');
      if (!verifyTotp(decryptString(this.env.CODE_ENC_KEY, user.mfaSecretEnc), input.totp)) {
        throw new AppError('INVALID_CREDENTIALS');
      }
    }
    await this.db.platform.user.update({
      where: { id: user.id },
      data: { failedLogins: 0, lockedUntil: null, lastLoginAt: new Date() },
    });
    const memberships = await this.activeMemberships(user.id);
    if (memberships.length === 0) {
      throw new AppError('FORBIDDEN', 'Your account is not linked to an active company.');
    }
    if (memberships.length === 1) {
      return { kind: 'TOKENS', ...(await this.issue(memberships[0].id)) };
    }
    const selectionToken = randomToken(24);
    await this.cache.putOnce(`tsel:${selectionToken}`, { userId: user.id }, SELECTION_TTL_SEC);
    return {
      kind: 'SELECT_COMPANY',
      selectionToken,
      companies: memberships.map((m) => ({ tenantId: m.tenantId, name: m.tenantName, role: m.roleName })),
    };
  }

  async selectCompany(selectionToken: string, tenantId: string): Promise<TokenPair> {
    const selection = await this.cache.take<{ userId: string }>(`tsel:${selectionToken}`);
    if (!selection) {
      throw new AppError('UNAUTHENTICATED');
    }
    const membership = (await this.activeMemberships(selection.userId)).find((m) => m.tenantId === tenantId);
    if (!membership) {
      throw new AppError('FORBIDDEN');
    }
    return this.issue(membership.id);
  }

  /** Switch company for a signed-in user without re-entering the password. */
  async switchCompany(userId: string, tenantId: string): Promise<TokenPair> {
    const membership = (await this.activeMemberships(userId)).find((m) => m.tenantId === tenantId);
    if (!membership) {
      throw new AppError('FORBIDDEN');
    }
    return this.issue(membership.id);
  }

  async companies(userId: string): Promise<CompanyChoice[]> {
    return (await this.activeMemberships(userId)).map((m) => ({ tenantId: m.tenantId, name: m.tenantName, role: m.roleName }));
  }

  async refreshTokens(token: string): Promise<TokenPair> {
    const rotated = await this.refresh.rotate('TENANT_USER', token, REFRESH_TTL_DAYS);
    const membership = await this.db.platform.tenantMembership.findUnique({
      where: { id: rotated.previous.subjectId },
      include: { user: true },
    });
    if (!membership || membership.status !== 'ACTIVE' || membership.user.status !== 'ACTIVE') {
      await this.refresh.revokeFamily(rotated.previous.familyId, 'MEMBERSHIP_INACTIVE');
      throw new AppError('UNAUTHENTICATED');
    }
    const access = await this.tokens.sign('TENANT_USER', {
      sub: membership.id,
      uid: membership.userId,
      tid: membership.tenantId,
      pv: membership.permVersion,
    });
    return { accessToken: access.token, refreshToken: rotated.token, accessExpiresAt: access.expiresAt.toISOString() };
  }

  async logout(token: string): Promise<void> {
    const record = await this.refresh.peek('TENANT_USER', token).catch(() => null);
    if (record) {
      await this.refresh.revokeFamily(record.familyId, 'LOGOUT');
    }
  }

  async inviteInfo(token: string) {
    const invite = await this.liveInvite(token);
    const [tenant, user] = await Promise.all([
      this.db.platform.tenant.findUniqueOrThrow({ where: { id: invite.tenantId }, select: { displayName: true } }),
      this.db.platform.user.findUnique({ where: { email: invite.email }, select: { passwordHash: true } }),
    ]);
    return { email: invite.email, fullName: invite.fullName, companyName: tenant.displayName, hasAccount: !!user?.passwordHash };
  }

  async acceptInvite(input: AcceptInviteInput): Promise<TokenPair> {
    const invite = await this.liveInvite(input.token);
    const existing = await this.db.platform.user.findUnique({ where: { email: invite.email } });
    if (existing?.passwordHash && !(await this.passwords.verify(existing.passwordHash, input.password))) {
      throw new AppError('INVALID_CREDENTIALS', 'This email already has an account. Enter its current password.');
    }
    const passwordHash = existing?.passwordHash ?? (await this.passwords.hash(input.password));
    const membershipId = await this.db.platform.$transaction(async (tx) => {
      const user = await tx.user.upsert({
        where: { email: invite.email },
        update: { passwordHash, fullName: existing?.passwordHash ? undefined : input.fullName },
        create: { email: invite.email, fullName: input.fullName, passwordHash, passwordChangedAt: new Date() },
      });
      const membership = await tx.tenantMembership.upsert({
        where: { tenantId_userId: { tenantId: invite.tenantId, userId: user.id } },
        update: { roleId: invite.roleId, status: 'ACTIVE', branchIds: invite.branchIds, departmentIds: invite.departmentIds },
        create: {
          tenantId: invite.tenantId,
          userId: user.id,
          roleId: invite.roleId,
          branchIds: invite.branchIds,
          departmentIds: invite.departmentIds,
        },
      });
      await tx.userInvitation.update({ where: { id: invite.id }, data: { acceptedAt: new Date() } });
      await this.audit.record(
        { action: 'user.invite.accept', entityType: 'membership', entityId: membership.id, tenantId: invite.tenantId },
        tx,
      );
      return membership.id;
    });
    return this.issue(membershipId);
  }

  async forgotPassword(email: string): Promise<void> {
    await this.cache.limit(`tforgot:${email}`, 3, 3600);
    const user = await this.db.platform.user.findUnique({ where: { email } });
    if (!user || user.status !== 'ACTIVE' || !user.passwordHash) {
      return;
    }
    const token = randomToken(32);
    await this.db.platform.passwordResetToken.create({
      data: { realm: 'TENANT_USER', subjectId: user.id, tokenHash: sha256Hex(token), expiresAt: new Date(Date.now() + 30 * 60_000) },
    });
    await this.queues.add(QUEUE.NOTIFY, 'email', {
      tenantId: null,
      to: email,
      subject: 'Reset your password',
      text: `Reset your password (valid for 30 minutes):\n${this.env.WEB_APP_URL}/reset-password?token=${token}\n\nIf you did not ask for this, ignore this email.`,
    });
  }

  async resetPassword(token: string, password: string): Promise<void> {
    const record = await this.db.platform.passwordResetToken.findUnique({ where: { tokenHash: sha256Hex(token) } });
    if (!record || record.realm !== 'TENANT_USER' || record.usedAt || record.expiresAt < new Date()) {
      throw new AppError('BAD_REQUEST', 'This reset link is invalid or has expired.');
    }
    await this.db.platform.$transaction(async (tx) => {
      await tx.passwordResetToken.update({ where: { id: record.id }, data: { usedAt: new Date() } });
      await tx.user.update({
        where: { id: record.subjectId },
        data: { passwordHash: await this.passwords.hash(password), passwordChangedAt: new Date(), failedLogins: 0, lockedUntil: null },
      });
    });
    const memberships = await this.db.platform.tenantMembership.findMany({ where: { userId: record.subjectId }, select: { id: true } });
    await Promise.all(memberships.map((m) => this.refresh.revokeBySubject('TENANT_USER', m.id, 'PASSWORD_RESET')));
  }

  private async liveInvite(token: string) {
    const invite = await this.db.platform.userInvitation.findUnique({ where: { tokenHash: sha256Hex(token) } });
    if (!invite || invite.acceptedAt || invite.revokedAt || invite.expiresAt < new Date()) {
      throw new AppError('BAD_REQUEST', 'This invitation is invalid or has expired.');
    }
    return invite;
  }

  private async activeMemberships(userId: string) {
    const rows = await this.db.platform.tenantMembership.findMany({
      where: { userId, status: 'ACTIVE' },
      include: { role: { select: { name: true } } },
    });
    const tenants = await this.db.platform.tenant.findMany({
      where: { id: { in: rows.map((r) => r.tenantId) }, status: { not: 'CANCELLED' } },
      select: { id: true, displayName: true },
    });
    const names = new Map(tenants.map((t) => [t.id, t.displayName]));
    return rows
      .filter((r) => names.has(r.tenantId))
      .map((r) => ({ id: r.id, tenantId: r.tenantId, tenantName: names.get(r.tenantId) ?? '', roleName: r.role.name }));
  }

  private async issue(membershipId: string): Promise<TokenPair> {
    const membership = await this.db.platform.tenantMembership.update({
      where: { id: membershipId },
      data: { lastActiveAt: new Date() },
    });
    const access = await this.tokens.sign('TENANT_USER', {
      sub: membership.id,
      uid: membership.userId,
      tid: membership.tenantId,
      pv: membership.permVersion,
    });
    const refreshToken = await this.refresh.issue({
      realm: 'TENANT_USER',
      subjectId: membership.id,
      tenantId: membership.tenantId,
      ttlDays: REFRESH_TTL_DAYS,
      absoluteExpiresAt: new Date(Date.now() + ABSOLUTE_DAYS * 86_400_000),
      ip: currentContext()?.ip,
      userAgent: currentContext()?.userAgent,
    });
    return { accessToken: access.token, refreshToken, accessExpiresAt: access.expiresAt.toISOString() };
  }

  private async registerFailure(userId: string, failures: number): Promise<void> {
    await this.db.platform.user.update({
      where: { id: userId },
      data: {
        failedLogins: failures,
        lockedUntil: failures >= MAX_FAILURES ? new Date(Date.now() + LOCK_MINUTES * 60_000) : undefined,
      },
    });
  }
}
