import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  type BindingStatusInput,
  type MobileActivateInput,
  type MobilePinResetInput,
  type MobileRefreshInput,
  popMessages,
  type TokenPair,
} from '@attendance/contracts';
import { AuditService } from '../../core/audit/audit.service.js';
import { PrincipalService } from '../../core/auth/principal.service.js';
import { RefreshTokenService } from '../../core/auth/refresh-token.service.js';
import { TokenService } from '../../core/auth/token.service.js';
import { ENV, type Env } from '../../core/config/env.js';
import { currentContext } from '../../core/context/request-context.js';
import { hmacHex, isP256PublicKey, keyFingerprint, randomToken, verifyDeviceSignature } from '../../core/crypto/crypto.util.js';
import { DbService } from '../../core/database/db.service.js';
import { AppError } from '../../core/http/app-error.js';
import { CacheService } from '../../core/redis/cache.service.js';
import { StorageService } from '../../core/storage/storage.service.js';
import { ActivationCodesService } from '../employees/activation-codes.service.js';

const NONCE_TTL_SEC = 120;
const REFRESH_TTL_DAYS = 90;
const ACTIVATION_SELFIE_MAX = 600_000;

export type ActivateOutcome =
  | ({ readonly status: 'ACTIVE' } & TokenPair & { readonly bindingId: string })
  | { readonly status: 'PENDING'; readonly bindingId: string; readonly selfieUpload: { readonly url: string; readonly headers: Record<string, string> } | null };

@Injectable()
export class MobileAuthService {
  private readonly logger = new Logger(MobileAuthService.name);

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly db: DbService,
    private readonly codes: ActivationCodesService,
    private readonly tokens: TokenService,
    private readonly refresh: RefreshTokenService,
    private readonly cache: CacheService,
    private readonly audit: AuditService,
    private readonly principals: PrincipalService,
    private readonly storage: StorageService,
  ) {}

  async nonce(): Promise<{ nonce: string; expiresInSec: number }> {
    await this.cache.limit(`nonce:${currentContext()?.ip ?? ''}`, 30, 60);
    const nonce = randomToken(24);
    await this.cache.putOnce(`nonce:${nonce}`, { t: Date.now() }, NONCE_TTL_SEC);
    return { nonce, expiresInSec: NONCE_TTL_SEC };
  }

  async consumeNonce(nonce: string): Promise<void> {
    const found = await this.cache.take(`nonce:${nonce}`);
    if (!found) throw new AppError('NONCE_INVALID');
  }

  async activate(input: MobileActivateInput): Promise<ActivateOutcome> {
    const ip = currentContext()?.ip ?? '';
    await this.cache.limit(`act:ip:${ip}`, 10, 15 * 60);
    await this.cache.limit(`act:inst:${input.device.installId}`, 5, 15 * 60);
    await this.consumeNonce(input.nonce);
    if (!isP256PublicKey(input.publicKey) || !verifyDeviceSignature(input.publicKey, popMessages.activate(input.nonce, input.phone), input.signature)) {
      throw new AppError('BAD_SIGNATURE');
    }
    const employee = await this.db.platform.employee.findUnique({ where: { livePhone: input.phone } });
    const failKey = `act:fail:${hmacHex(this.env.DEVICE_ID_HMAC_KEY, input.phone)}`;
    if (!employee) {
      // Same work and same answer as a wrong code, so the response never reveals whether a phone exists.
      this.codes.digest('00000000-0000-0000-0000-000000000000', 'x', 'ACTIVATION', input.code);
      await this.cache.hit(failKey, 86_400);
      throw new AppError('ACTIVATION_FAILED');
    }
    const tenant = await this.db.platform.tenant.findUniqueOrThrow({ where: { id: employee.tenantId } });
    const bound = await this.db.platform.deviceBinding.findUnique({ where: { liveEmployeeId: employee.id } });
    const check = await this.codes.check(employee.tenantId, employee.id, 'ACTIVATION', input.code);
    if (!check.ok || tenant.status === 'SUSPENDED' || tenant.status === 'CANCELLED' || bound) {
      await this.cache.hit(failKey, 86_400);
      throw new AppError('ACTIVATION_FAILED');
    }
    const approval = await this.db.platform.tenantFeature.findUnique({
      where: { tenantId_key: { tenantId: employee.tenantId, key: 'DEVICE_APPROVAL' } },
    });
    const needsApproval = approval?.enabled ?? false;
    const binding = await this.db.platform.$transaction(async (tx) => {
      const created = await tx.deviceBinding.create({
        data: {
          tenantId: employee.tenantId,
          employeeId: employee.id,
          activationCodeId: check.codeId,
          installId: input.device.installId,
          platform: input.device.platform,
          publicKeySpki: input.publicKey,
          keyFingerprint: keyFingerprint(input.publicKey),
          androidIdHmac: input.device.androidId ? hmacHex(this.env.DEVICE_ID_HMAC_KEY, input.device.androidId) : null,
          manufacturer: input.device.manufacturer,
          model: input.device.model,
          osVersion: input.device.osVersion,
          appVersion: input.device.appVersion,
          fcmToken: input.fcmToken ?? null,
          fcmTokenUpdatedAt: input.fcmToken ? new Date() : null,
          status: needsApproval ? 'PENDING' : 'ACTIVE',
          activatedAt: needsApproval ? null : new Date(),
          lastSeenAt: new Date(),
          liveEmployeeId: employee.id,
        },
      });
      await this.codes.consume(tx, check.codeId, created.id);
      if (!needsApproval) {
        await tx.employee.update({ where: { id: employee.id }, data: { status: 'ACTIVE', activatedAt: employee.activatedAt ?? new Date() } });
      }
      await this.audit.record(
        {
          action: needsApproval ? 'device.binding.pending' : 'auth.activation.succeeded',
          entityType: 'device_binding',
          entityId: created.id,
          tenantId: employee.tenantId,
          after: { employeeId: employee.id, model: input.device.model },
        },
        tx,
      );
      return created;
    });
    await this.principals.invalidateEmployee(employee.id);
    if (needsApproval) {
      const key = `t/${employee.tenantId}/activation/${binding.id}.jpg`;
      await this.db.platform.deviceBinding.update({ where: { id: binding.id }, data: { activationSelfieKey: key } });
      const upload = await this.storage.presignPut(key, 'image/jpeg', ACTIVATION_SELFIE_MAX, 300).catch(() => null);
      return { status: 'PENDING', bindingId: binding.id, selfieUpload: upload ? { url: upload.url, headers: { ...upload.headers } } : null };
    }
    return { status: 'ACTIVE', bindingId: binding.id, ...(await this.issue(employee.id, employee.tenantId, binding.id)) };
  }

  async bindingStatus(input: BindingStatusInput): Promise<{ status: 'PENDING' } | ({ status: 'ACTIVE' } & TokenPair)> {
    await this.consumeNonce(input.nonce);
    const binding = await this.db.platform.deviceBinding.findUnique({ where: { id: input.bindingId } });
    if (!binding || !verifyDeviceSignature(binding.publicKeySpki, popMessages.bindingStatus(input.nonce, input.bindingId), input.signature)) {
      throw new AppError('BAD_SIGNATURE');
    }
    if (binding.status === 'REVOKED') throw new AppError('BINDING_INACTIVE');
    if (binding.status === 'PENDING') return { status: 'PENDING' };
    return { status: 'ACTIVE', ...(await this.issue(binding.employeeId, binding.tenantId, binding.id)) };
  }

  async refreshTokens(input: MobileRefreshInput): Promise<TokenPair> {
    await this.consumeNonce(input.nonce);
    const record = await this.refresh.peek('EMPLOYEE', input.refreshToken);
    if (!record.bindingId) throw new AppError('UNAUTHENTICATED');
    const binding = await this.db.platform.deviceBinding.findUnique({ where: { id: record.bindingId } });
    if (!binding || binding.status !== 'ACTIVE') throw new AppError('BINDING_INACTIVE');
    if (!verifyDeviceSignature(binding.publicKeySpki, popMessages.refresh(input.nonce), input.signature)) {
      throw new AppError('BAD_SIGNATURE');
    }
    const rotated = await this.refresh.rotate('EMPLOYEE', input.refreshToken, REFRESH_TTL_DAYS);
    await this.db.platform.deviceBinding.update({ where: { id: binding.id }, data: { lastSeenAt: new Date() } });
    const access = await this.tokens.sign('EMPLOYEE', { sub: binding.employeeId, tid: binding.tenantId, bid: binding.id });
    return { accessToken: access.token, refreshToken: rotated.token, accessExpiresAt: access.expiresAt.toISOString() };
  }

  /** Authorises a local PIN reset on the already-bound phone using an employer-issued PIN_RESET code. */
  async pinReset(input: MobilePinResetInput): Promise<TokenPair> {
    await this.cache.limit(`pinreset:${input.installId}`, 10, 3600);
    await this.consumeNonce(input.nonce);
    const employee = await this.db.platform.employee.findUnique({ where: { livePhone: input.phone } });
    const binding = employee ? await this.db.platform.deviceBinding.findUnique({ where: { liveEmployeeId: employee.id } }) : null;
    if (!employee || !binding || binding.status !== 'ACTIVE' || binding.installId !== input.installId) {
      throw new AppError('ACTIVATION_FAILED');
    }
    if (!verifyDeviceSignature(binding.publicKeySpki, popMessages.pinReset(input.nonce, input.phone), input.signature)) {
      throw new AppError('BAD_SIGNATURE');
    }
    const check = await this.codes.check(employee.tenantId, employee.id, 'PIN_RESET', input.code);
    if (!check.ok) throw new AppError('ACTIVATION_FAILED');
    await this.db.platform.$transaction(async (tx) => {
      await this.codes.consume(tx, check.codeId, binding.id);
      await this.audit.record({ action: 'auth.pin_reset.succeeded', entityType: 'device_binding', entityId: binding.id, tenantId: employee.tenantId }, tx);
    });
    await this.refresh.revokeByBinding(binding.id, 'PIN_RESET');
    return this.issue(employee.id, employee.tenantId, binding.id);
  }

  async updateFcmToken(bindingId: string, fcmToken: string): Promise<void> {
    await this.db.platform.deviceBinding.update({ where: { id: bindingId }, data: { fcmToken, fcmTokenUpdatedAt: new Date() } });
  }

  private async issue(employeeId: string, tenantId: string, bindingId: string): Promise<TokenPair> {
    const access = await this.tokens.sign('EMPLOYEE', { sub: employeeId, tid: tenantId, bid: bindingId });
    const refreshToken = await this.refresh.issue({
      realm: 'EMPLOYEE',
      subjectId: employeeId,
      tenantId,
      bindingId,
      ttlDays: REFRESH_TTL_DAYS,
      ip: currentContext()?.ip,
      userAgent: currentContext()?.userAgent,
    });
    this.logger.log(`Employee session issued for binding ${bindingId}`);
    return { accessToken: access.token, refreshToken, accessExpiresAt: access.expiresAt.toISOString() };
  }
}
