import { Inject, Injectable } from '@nestjs/common';
import type { CodePurpose } from '@attendance/contracts';
import { AuditService } from '../../core/audit/audit.service.js';
import { ENV, type Env } from '../../core/config/env.js';
import { PRODUCT_NAME } from '../../core/config/product.js';
import { currentContext, SYSTEM_ACTOR } from '../../core/context/request-context.js';
import {
  decryptString,
  encryptString,
  formatCode,
  generateActivationCode,
  hmacHex,
  safeEqualHex,
} from '../../core/crypto/crypto.util.js';
import { DbService, type PlatformTx, type TenantTx } from '../../core/database/db.service.js';
import { NotifyService } from '../../core/notify/notify.service.js';

export const MAX_CODE_ATTEMPTS = 5;
const PEPPER_VERSION = 1;

export interface IssuedCode {
  readonly code: string;
  readonly formatted: string;
  readonly expiresAt: Date;
}

export type CodeCheck =
  | { readonly ok: true; readonly codeId: string }
  | { readonly ok: false; readonly locked: boolean };

type Tx = TenantTx | PlatformTx;

/**
 * Employer-issued one-time codes. Verification uses a peppered HMAC only; an AES-GCM copy is
 * kept while the code is live so authorised users can reveal or export it, and wiped on use,
 * lock, revoke or expiry.
 */
@Injectable()
export class ActivationCodesService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly notify: NotifyService,
  ) {}

  digest(tenantId: string, employeeId: string, purpose: CodePurpose, code: string): string {
    return hmacHex(this.env.CODE_PEPPER_V1, `${tenantId}|${employeeId}|${purpose}|${code}`);
  }

  async issue(
    tx: Tx,
    args: { tenantId: string; employeeId: string; purpose: CodePurpose; via: string; ttlDays: number },
  ): Promise<IssuedCode> {
    const actor = currentContext()?.actor ?? SYSTEM_ACTOR;
    const liveKey = `${args.employeeId}:${args.purpose}`;
    await tx.activationCode.updateMany({
      where: { liveKey },
      data: { status: 'REVOKED', revokedAt: new Date(), liveKey: null, codeEnc: null },
    });
    const code = generateActivationCode();
    const expiresAt = new Date(Date.now() + args.ttlDays * 86_400_000);
    await tx.activationCode.create({
      data: {
        tenantId: args.tenantId,
        employeeId: args.employeeId,
        purpose: args.purpose,
        codeHmac: this.digest(args.tenantId, args.employeeId, args.purpose, code),
        codeEnc: encryptString(this.env.CODE_ENC_KEY, code),
        pepperVersion: PEPPER_VERSION,
        expiresAt,
        issuedVia: args.via,
        issuedByActor: actor.type,
        issuedById: actor.id,
        liveKey,
      },
    });
    await this.audit.record(
      {
        action: 'activation_code.issued',
        entityType: 'employee',
        entityId: args.employeeId,
        tenantId: args.tenantId,
        after: { purpose: args.purpose, via: args.via, expiresAt },
      },
      tx,
    );
    return { code, formatted: formatCode(code), expiresAt };
  }

  /** Plaintext of a live, unexpired code, or null. */
  async reveal(employeeId: string, purpose: CodePurpose): Promise<IssuedCode | null> {
    const live = await this.db.tenant.activationCode.findFirst({ where: { liveKey: `${employeeId}:${purpose}` } });
    if (!live?.codeEnc || live.expiresAt < new Date()) {
      return null;
    }
    const code = decryptString(this.env.CODE_ENC_KEY, live.codeEnc);
    return { code, formatted: formatCode(code), expiresAt: live.expiresAt };
  }

  /** Checks a submitted code; counts failures and locks the code at MAX_CODE_ATTEMPTS. */
  async check(tenantId: string, employeeId: string, purpose: CodePurpose, code: string): Promise<CodeCheck> {
    const live = await this.db.platform.activationCode.findFirst({
      where: { tenantId, liveKey: `${employeeId}:${purpose}` },
    });
    const candidate = this.digest(tenantId, employeeId, purpose, code);
    if (!live || live.expiresAt < new Date()) {
      return { ok: false, locked: false };
    }
    if (safeEqualHex(live.codeHmac, candidate)) {
      return { ok: true, codeId: live.id };
    }
    const attempts = live.failedAttempts + 1;
    const locked = attempts >= MAX_CODE_ATTEMPTS;
    await this.db.platform.activationCode.update({
      where: { id: live.id },
      data: locked
        ? { failedAttempts: attempts, status: 'LOCKED', lockedAt: new Date(), liveKey: null, codeEnc: null }
        : { failedAttempts: attempts },
    });
    if (locked) {
      await this.audit.record({ action: 'activation_code.locked', entityType: 'employee', entityId: employeeId, tenantId });
    }
    return { ok: false, locked };
  }

  async consume(tx: Tx, codeId: string, bindingId: string | null): Promise<void> {
    await tx.activationCode.update({
      where: { id: codeId },
      data: { status: 'USED', usedAt: new Date(), usedByBindingId: bindingId, liveKey: null, codeEnc: null },
    });
  }

  /**
   * Emails the live activation code to the employee (needs tenant context). Returns false without an
   * email address, without a live code, or when the mail server refused it; the audit records only real sends.
   */
  async emailActivationCode(employeeId: string): Promise<boolean> {
    const employee = await this.db.tenant.employee.findUnique({ where: { id: employeeId } });
    if (!employee?.email) return false;
    const code = await this.reveal(employee.id, 'ACTIVATION');
    if (!code) return false;
    const tenant = await this.db.platform.tenant.findUniqueOrThrow({ where: { id: employee.tenantId }, select: { displayName: true } });
    const sent = await this.notify.email({
      to: employee.email,
      subject: `Your ${tenant.displayName} ${PRODUCT_NAME} app code`,
      text: [
        `Hello ${employee.fullName},`,
        '',
        `Install the ${PRODUCT_NAME} app and sign in with your mobile number ${employee.phoneE164} and this one-time code:`,
        '',
        `    ${code.formatted}`,
        '',
        `The code works once and expires on ${code.expiresAt.toISOString().slice(0, 10)}. Do not share it.`,
      ].join('\n'),
    });
    if (!sent) return false;
    await this.audit.record({ action: 'activation_code.emailed', entityType: 'employee', entityId: employee.id, tenantId: employee.tenantId });
    return true;
  }

  async revokeAll(tx: Tx, employeeId: string): Promise<void> {
    await tx.activationCode.updateMany({
      where: { employeeId, status: 'ISSUED' },
      data: { status: 'REVOKED', revokedAt: new Date(), liveKey: null, codeEnc: null },
    });
  }
}
