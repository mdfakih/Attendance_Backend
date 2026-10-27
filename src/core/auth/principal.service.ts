import { Injectable } from '@nestjs/common';
import {
  type FeatureState,
  fullPermissionSet,
  type PermissionSet,
  type PlatformRole,
  resolveFeatures,
  type RoleKind,
  type TenantStatus,
} from '@attendance/contracts';
import { DbService } from '../database/db.service.js';
import { AppError } from '../http/app-error.js';
import { CacheService } from '../redis/cache.service.js';

export interface CachedTenantUser {
  readonly membershipId: string;
  readonly userId: string;
  readonly fullName: string;
  readonly roleId: string;
  readonly roleKind: RoleKind;
  readonly permissions: PermissionSet;
  readonly branchIds: readonly string[];
  readonly departmentIds: readonly string[];
  readonly permVersion: number;
  readonly active: boolean;
}

export interface CachedEmployee {
  readonly employeeId: string;
  readonly fullName: string;
  readonly active: boolean;
  readonly consentAcceptedAt: string | null;
}

export interface CachedPlatformUser {
  readonly id: string;
  readonly fullName: string;
  readonly role: PlatformRole;
  readonly active: boolean;
}

const TTL = 60;

export const cacheKeys = {
  tenantStatus: (tid: string) => `t:status:${tid}`,
  features: (tid: string) => `t:features:${tid}`,
  membership: (mid: string) => `p:tu:${mid}`,
  employee: (eid: string) => `p:emp:${eid}`,
  binding: (bid: string) => `p:bind:${bid}`,
  platformUser: (id: string) => `p:pu:${id}`,
};

/** Loads (and caches briefly) everything a guard needs to accept a token. */
@Injectable()
export class PrincipalService {
  constructor(
    private readonly db: DbService,
    private readonly cache: CacheService,
  ) {}

  async tenantStatus(tenantId: string): Promise<TenantStatus> {
    const status = await this.cache.remember(cacheKeys.tenantStatus(tenantId), TTL, async () => {
      const tenant = await this.db.platform.tenant.findUnique({ where: { id: tenantId }, select: { status: true } });
      return tenant?.status ?? null;
    });
    if (!status) {
      throw new AppError('UNAUTHENTICATED');
    }
    return status;
  }

  async features(tenantId: string): Promise<FeatureState> {
    return this.cache.remember(cacheKeys.features(tenantId), TTL, async () => {
      const rows = await this.db.platform.tenantFeature.findMany({ where: { tenantId }, select: { key: true, enabled: true } });
      return resolveFeatures(rows);
    });
  }

  async tenantUser(membershipId: string, tenantId: string): Promise<CachedTenantUser> {
    const cached = await this.cache.remember(cacheKeys.membership(membershipId), TTL, async () => {
      const m = await this.db.platform.tenantMembership.findFirst({
        where: { id: membershipId, tenantId },
        include: { role: true, user: { select: { fullName: true, status: true } } },
      });
      if (!m) return null;
      const permissions =
        m.role.kind === 'ADMIN' ? fullPermissionSet() : ((m.role.permissions ?? {}) as PermissionSet);
      return {
        membershipId: m.id,
        userId: m.userId,
        fullName: m.user.fullName,
        roleId: m.roleId,
        roleKind: m.role.kind,
        permissions,
        branchIds: m.branchIds,
        departmentIds: m.departmentIds,
        permVersion: m.permVersion,
        active: m.status === 'ACTIVE' && m.user.status === 'ACTIVE',
      } satisfies CachedTenantUser;
    });
    if (!cached || !cached.active) {
      throw new AppError('UNAUTHENTICATED');
    }
    return cached;
  }

  async employee(employeeId: string, tenantId: string): Promise<CachedEmployee> {
    const cached = await this.cache.remember(cacheKeys.employee(employeeId), TTL, async () => {
      const e = await this.db.platform.employee.findFirst({
        where: { id: employeeId, tenantId },
        select: { id: true, fullName: true, status: true },
      });
      if (!e) return null;
      const consent = await this.db.platform.consentRecord.findFirst({
        where: { tenantId, subjectType: 'EMPLOYEE', subjectId: employeeId },
        orderBy: { createdAt: 'desc' },
        select: { action: true, createdAt: true },
      });
      return {
        employeeId: e.id,
        fullName: e.fullName,
        active: e.status === 'ACTIVE',
        consentAcceptedAt: consent?.action === 'GRANT' ? consent.createdAt.toISOString() : null,
      } satisfies CachedEmployee;
    });
    if (!cached) {
      throw new AppError('BINDING_INACTIVE');
    }
    return cached;
  }

  async bindingActive(bindingId: string, employeeId: string): Promise<boolean> {
    const status = await this.cache.remember(cacheKeys.binding(bindingId), 300, async () => {
      const b = await this.db.platform.deviceBinding.findUnique({
        where: { id: bindingId },
        select: { status: true, employeeId: true },
      });
      return b && b.employeeId === employeeId ? b.status : 'REVOKED';
    });
    return status === 'ACTIVE';
  }

  async platformUser(id: string): Promise<CachedPlatformUser> {
    const cached = await this.cache.remember(cacheKeys.platformUser(id), TTL, async () => {
      const u = await this.db.platform.platformUser.findUnique({ where: { id } });
      return u ? { id: u.id, fullName: u.fullName, role: u.role, active: u.status === 'ACTIVE' } : null;
    });
    if (!cached || !cached.active) {
      throw new AppError('UNAUTHENTICATED');
    }
    return cached;
  }

  invalidateMembership(membershipId: string): Promise<void> {
    return this.cache.del(cacheKeys.membership(membershipId));
  }

  invalidateTenant(tenantId: string): Promise<void> {
    return this.cache.del(cacheKeys.tenantStatus(tenantId), cacheKeys.features(tenantId));
  }

  invalidateEmployee(employeeId: string): Promise<void> {
    return this.cache.del(cacheKeys.employee(employeeId));
  }

  invalidateBinding(bindingId: string): Promise<void> {
    return this.cache.del(cacheKeys.binding(bindingId));
  }

  invalidatePlatformUser(id: string): Promise<void> {
    return this.cache.del(cacheKeys.platformUser(id));
  }
}
