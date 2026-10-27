import { Injectable } from '@nestjs/common';
import { PrismaService } from './prisma.service.js';
import { createTenantClient, type TenantClient } from './tenant-extension.js';

export type TenantTx = Parameters<Parameters<TenantClient['$transaction']>[0]>[0];
export type PlatformTx = Parameters<Parameters<PrismaService['$transaction']>[0]>[0];

/**
 * Entry point for data access.
 * - `tenant`: auto-scoped to the request's tenant (default for all tenant modules).
 * - `platform`: unscoped; restricted to platform, auth and scheduler code.
 */
@Injectable()
export class DbService {
  readonly tenant: TenantClient;

  constructor(readonly platform: PrismaService) {
    this.tenant = createTenantClient(platform);
  }

  /** Serialises work per key inside a tenant transaction (pg advisory xact lock). */
  async lock(tx: TenantTx | PlatformTx, key: string): Promise<void> {
    // executeRaw: the function returns `void`, which the driver cannot map as a result column.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
  }
}
