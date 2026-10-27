import type { PrismaClient } from '../../generated/prisma/client.js';
import { currentContext } from '../context/request-context.js';

/** Models without tenant ownership (or with optional tenant) — never auto-scoped. */
export const GLOBAL_MODELS: ReadonlySet<string> = new Set([
  'PlatformUser',
  'Plan',
  'Tenant',
  'User',
  'PasswordResetToken',
  'RefreshToken',
  'ConsentNotice',
  'AuditLog',
  'UsageDailySnapshot',
]);

const WHERE_OPS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'delete',
  'deleteMany',
]);

export class TenantContextMissingError extends Error {
  constructor(model: string, operation: string) {
    super(`Tenant context missing for ${model}.${operation}`);
    this.name = 'TenantContextMissingError';
  }
}

type Args = Record<string, unknown>;

function withTenantData(data: unknown, tenantId: string): unknown {
  if (Array.isArray(data)) {
    return data.map((row: Args) => ({ ...row, tenantId }));
  }
  return { ...(data as Args), tenantId };
}

/** Returns new args with tenantId injected for the given operation. Pure; exported for tests. */
export function scopeArgs(operation: string, args: Args | undefined, tenantId: string): Args {
  const current = args ?? {};
  if (WHERE_OPS.has(operation)) {
    return { ...current, where: { ...((current['where'] as Args) ?? {}), tenantId } };
  }
  if (operation === 'create' || operation === 'createMany' || operation === 'createManyAndReturn') {
    return { ...current, data: withTenantData(current['data'], tenantId) };
  }
  if (operation === 'upsert') {
    return {
      ...current,
      where: { ...((current['where'] as Args) ?? {}), tenantId },
      create: { ...((current['create'] as Args) ?? {}), tenantId },
    };
  }
  return current;
}

/**
 * Prisma client extension that injects `tenantId` from the request context into every
 * tenant-owned model operation and refuses to run without a context.
 */
export function createTenantClient(base: PrismaClient) {
  return base.$extends({
    name: 'tenant-scope',
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (GLOBAL_MODELS.has(model)) {
            return query(args);
          }
          const tenantId = currentContext()?.tenantId;
          if (!tenantId) {
            throw new TenantContextMissingError(model, operation);
          }
          return query(scopeArgs(operation, args as Args, tenantId) as typeof args);
        },
      },
    },
  });
}

export type TenantClient = ReturnType<typeof createTenantClient>;
