import { AsyncLocalStorage } from 'node:async_hooks';
import type { ActorType, AuthRealm, FeatureState, PermissionSet, PlatformRole, RoleKind } from '@attendance/contracts';
import { AppError } from '../http/app-error.js';

export interface Actor {
  readonly type: ActorType;
  readonly id: string | null;
  readonly name?: string;
}

export interface TenantUserPrincipal {
  readonly membershipId: string;
  readonly userId: string;
  readonly roleId: string;
  readonly roleKind: RoleKind;
  readonly permissions: PermissionSet;
  readonly branchIds: readonly string[];
  readonly departmentIds: readonly string[];
}

export interface EmployeePrincipal {
  readonly employeeId: string;
  readonly bindingId: string;
}

export interface PlatformPrincipal {
  readonly platformUserId: string;
  readonly role: PlatformRole;
}

export interface RequestContext {
  readonly requestId: string;
  readonly ip?: string;
  readonly userAgent?: string;
  readonly realm?: AuthRealm;
  readonly tenantId?: string;
  readonly actor: Actor;
  readonly tenantUser?: TenantUserPrincipal;
  readonly employee?: EmployeePrincipal;
  readonly platform?: PlatformPrincipal;
  readonly features?: FeatureState;
}

/**
 * One mutable slot per request holding an immutable context value. Guards replace the
 * value (never mutate it) once the caller is authenticated.
 */
interface ContextSlot {
  value: RequestContext;
}

const storage = new AsyncLocalStorage<ContextSlot>();

export const SYSTEM_ACTOR: Actor = { type: 'SYSTEM', id: null, name: 'system' };

export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run({ value: ctx }, fn);
}

/** Runs work as the system actor inside a tenant. */
export function runAsTenant<T>(tenantId: string, fn: () => Promise<T>, extra: Partial<RequestContext> = {}): Promise<T> {
  return runWithContext({ requestId: `job-${Date.now().toString(36)}`, actor: SYSTEM_ACTOR, tenantId, ...extra }, fn);
}

export function currentContext(): RequestContext | undefined {
  return storage.getStore()?.value;
}

export function updateContext(patch: Partial<RequestContext>): RequestContext {
  const slot = storage.getStore();
  if (!slot) {
    throw new Error('updateContext called outside a request context');
  }
  slot.value = { ...slot.value, ...patch };
  return slot.value;
}

export function requireContext(): RequestContext {
  const ctx = currentContext();
  if (!ctx) {
    throw new Error('No request context');
  }
  return ctx;
}

export function requireTenantId(): string {
  const tenantId = currentContext()?.tenantId;
  if (!tenantId) {
    throw new AppError('UNAUTHENTICATED', 'Tenant context missing');
  }
  return tenantId;
}

export function requireTenantUser(): TenantUserPrincipal {
  const user = currentContext()?.tenantUser;
  if (!user) {
    throw new AppError('UNAUTHENTICATED');
  }
  return user;
}

export function requireEmployee(): EmployeePrincipal {
  const employee = currentContext()?.employee;
  if (!employee) {
    throw new AppError('UNAUTHENTICATED');
  }
  return employee;
}

export function requirePlatform(): PlatformPrincipal {
  const platform = currentContext()?.platform;
  if (!platform) {
    throw new AppError('UNAUTHENTICATED');
  }
  return platform;
}
