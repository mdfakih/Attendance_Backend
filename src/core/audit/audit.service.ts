import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import { currentContext, SYSTEM_ACTOR } from '../context/request-context.js';
import { DbService, type PlatformTx, type TenantTx } from '../database/db.service.js';

export interface AuditEntry {
  readonly action: string;
  readonly entityType: string;
  readonly entityId?: string | null;
  readonly before?: unknown;
  readonly after?: unknown;
  readonly reason?: string | null;
  /** Defaults to the request tenant; pass null for platform-level events. */
  readonly tenantId?: string | null;
}

const REDACTED_KEYS = new Set(['code', 'password', 'passwordHash', 'token', 'refreshToken', 'codeHmac', 'codeEnc', 'mfaSecretEnc']);

/** Removes secrets from audit payloads (recursively). Exported for tests. */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redact);
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, REDACTED_KEYS.has(k) ? '[redacted]' : redact(v)]),
    );
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  return value;
}

type Writer = Pick<TenantTx | PlatformTx, 'auditLog'>;

/** Append-only audit trail. Write inside the same transaction as the change when possible. */
@Injectable()
export class AuditService {
  constructor(private readonly db: DbService) {}

  async record(entry: AuditEntry, tx?: Writer): Promise<void> {
    const ctx = currentContext();
    const actor = ctx?.actor ?? SYSTEM_ACTOR;
    const writer: Writer = tx ?? this.db.platform;
    await writer.auditLog.create({
      data: {
        tenantId: entry.tenantId === undefined ? (ctx?.tenantId ?? null) : entry.tenantId,
        actorType: actor.type,
        actorId: actor.id,
        actorName: actor.name ?? null,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId ?? null,
        before: (entry.before === undefined ? undefined : redact(entry.before)) as Prisma.InputJsonValue | undefined,
        after: (entry.after === undefined ? undefined : redact(entry.after)) as Prisma.InputJsonValue | undefined,
        reason: entry.reason ?? null,
        requestId: ctx?.requestId ?? null,
        ip: ctx?.ip ?? null,
        userAgent: ctx?.userAgent?.slice(0, 300) ?? null,
      },
    });
  }
}
