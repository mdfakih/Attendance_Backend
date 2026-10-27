import { SetMetadata } from '@nestjs/common';
import type {
  AuthRealm,
  FeatureKey,
  PermissionAction,
  PermissionModule,
  PlatformRole,
} from '@attendance/contracts';

export const IS_PUBLIC = 'auth:public';
export const REALM = 'auth:realm';
export const PERMISSION = 'rbac:permission';
export const ADMIN_ONLY = 'rbac:admin-only';
export const PLATFORM_ROLES = 'rbac:platform-roles';
export const FEATURE = 'feature:required';
export const ALLOW_SUSPENDED = 'tenant:allow-suspended';
export const ALLOW_WITHOUT_CONSENT = 'employee:allow-without-consent';

export interface PermissionRequirement {
  readonly module: PermissionModule;
  readonly action: PermissionAction;
}

/** No authentication (login, activation, health). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Controller belongs to a realm; every non-public route must declare one. */
export const Realm = (realm: AuthRealm) => SetMetadata(REALM, realm);
export const TenantApi = () => Realm('TENANT_USER');
export const EmployeeApi = () => Realm('EMPLOYEE');
export const PlatformApi = () => Realm('PLATFORM_USER');

export const RequirePermission = (module: PermissionModule, action: PermissionAction) =>
  SetMetadata(PERMISSION, { module, action } satisfies PermissionRequirement);

export const AdminOnly = () => SetMetadata(ADMIN_ONLY, true);
export const PlatformRoles = (...roles: PlatformRole[]) => SetMetadata(PLATFORM_ROLES, roles);
export const RequireFeature = (key: FeatureKey) => SetMetadata(FEATURE, key);

/** Mutations allowed while the tenant is suspended (e.g. billing views). */
export const AllowSuspended = () => SetMetadata(ALLOW_SUSPENDED, true);

/** Employee routes reachable before the privacy notice is accepted. */
export const AllowWithoutConsent = () => SetMetadata(ALLOW_WITHOUT_CONSENT, true);
