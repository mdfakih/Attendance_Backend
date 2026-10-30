import { describe, expect, it, vi } from 'vitest';
import type { AuditService } from '../../core/audit/audit.service.js';
import type { PrincipalService } from '../../core/auth/principal.service.js';
import type { DbService } from '../../core/database/db.service.js';
import { AppError } from '../../core/http/app-error.js';
import { cleanPermissions, RolesService } from './roles.service.js';

const TENANT = '01a18b4c-0000-7000-8000-000000000001';
const OTHER_TENANT = '01a18b4c-0000-7000-8000-000000000002';

interface FakeRole {
  id: string;
  tenantId: string;
  name: string;
  kind: 'ADMIN' | 'MANAGER';
  description: string | null;
  isSystem: boolean;
  permissions: Record<string, string[]>;
}

function setup(options: { members?: string[]; invites?: number; uniqueViolation?: boolean } = {}) {
  const roles: FakeRole[] = [
    { id: 'admin', tenantId: TENANT, name: 'Admin', kind: 'ADMIN', description: null, isSystem: true, permissions: {} },
    { id: 'manager', tenantId: TENANT, name: 'Manager', kind: 'MANAGER', description: null, isSystem: false, permissions: {} },
    { id: 'foreign', tenantId: OTHER_TENANT, name: 'Manager', kind: 'MANAGER', description: null, isSystem: false, permissions: {} },
  ];
  const members = options.members ?? [];
  const uniqueError = Object.assign(new Error('unique'), { code: 'P2002' });
  const db = {
    platform: {
      tenant: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => (where.id === TENANT ? { id: TENANT } : null)) },
      role: {
        findFirst: vi.fn(async ({ where }: { where: { id: string; tenantId: string } }) =>
          roles.find((r) => r.id === where.id && r.tenantId === where.tenantId) ?? null,
        ),
        create: vi.fn(async ({ data }: { data: Omit<FakeRole, 'id' | 'isSystem'> }) => {
          if (options.uniqueViolation) throw uniqueError;
          return { ...data, id: 'new', isSystem: false };
        }),
        update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<FakeRole> }) => ({
          ...roles.find((r) => r.id === where.id),
          ...data,
        })),
        delete: vi.fn(async () => undefined),
      },
      tenantMembership: {
        count: vi.fn(async () => members.length),
        findMany: vi.fn(async () => members.map((id) => ({ id }))),
        updateMany: vi.fn(async () => ({ count: members.length })),
      },
      userInvitation: { count: vi.fn(async () => options.invites ?? 0) },
    },
  };
  const audit = { record: vi.fn(async () => undefined) };
  const principals = { invalidateMembership: vi.fn(async () => undefined) };
  const service = new RolesService(db as unknown as DbService, audit as unknown as AuditService, principals as unknown as PrincipalService);
  return { service, db, audit, principals };
}

const conflict = (message: RegExp) => expect.objectContaining({ code: 'CONFLICT', message: expect.stringMatching(message) });

describe('cleanPermissions', () => {
  it('drops unknown modules, empty lists and duplicate actions', () => {
    const input = { DASHBOARD: ['view', 'view'], LEAVE: [], BILLING: ['view'] } as unknown as Parameters<typeof cleanPermissions>[0];
    expect(cleanPermissions(input)).toEqual({ DASHBOARD: ['view'] });
  });
});

describe('RolesService', () => {
  it('creates a manager role for the given client with cleaned permissions', async () => {
    const { service, db, audit } = setup();
    await service.create(TENANT, { name: 'Supervisor', permissions: { ATTENDANCE: ['view', 'view'] } });
    expect(db.platform.role.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ tenantId: TENANT, kind: 'MANAGER', permissions: { ATTENDANCE: ['view'] } }),
    });
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'role.create', tenantId: TENANT }));
  });

  it('reports a duplicate name as a readable conflict', async () => {
    const { service } = setup({ uniqueViolation: true });
    await expect(service.create(TENANT, { name: 'Manager', permissions: {} })).rejects.toEqual(conflict(/already exists/));
  });

  it('refuses an unknown client', async () => {
    const { service } = setup();
    await expect(service.create(OTHER_TENANT, { name: 'X1', permissions: {} })).rejects.toBeInstanceOf(AppError);
  });

  it('never edits the Admin role', async () => {
    const { service, db } = setup();
    await expect(service.update(TENANT, 'admin', { name: 'Admin', permissions: {} })).rejects.toEqual(conflict(/full access/));
    expect(db.platform.role.update).not.toHaveBeenCalled();
  });

  it('cannot reach a role of another client', async () => {
    const { service } = setup();
    await expect(service.update(TENANT, 'foreign', { name: 'Manager', permissions: {} })).rejects.toEqual(
      expect.objectContaining({ code: 'NOT_FOUND' }),
    );
  });

  it('signs the role’s users onto the new permissions after an edit', async () => {
    const { service, db, principals } = setup({ members: ['m1', 'm2'] });
    await service.update(TENANT, 'manager', { name: 'Manager', permissions: { DASHBOARD: ['view'] } });
    expect(db.platform.tenantMembership.updateMany).toHaveBeenCalledWith({
      where: { tenantId: TENANT, roleId: 'manager' },
      data: { permVersion: { increment: 1 } },
    });
    expect(principals.invalidateMembership).toHaveBeenCalledTimes(2);
  });

  it('only deletes a role nobody holds or is invited to', async () => {
    await expect(setup({ members: ['m1'] }).service.remove(TENANT, 'manager')).rejects.toEqual(conflict(/Move its users/));
    await expect(setup({ invites: 1 }).service.remove(TENANT, 'manager')).rejects.toEqual(conflict(/Move its users/));
    await expect(setup().service.remove(TENANT, 'admin')).rejects.toEqual(conflict(/cannot be deleted/));
    const { service, db } = setup();
    await service.remove(TENANT, 'manager');
    expect(db.platform.role.delete).toHaveBeenCalledWith({ where: { id: 'manager' } });
  });
});
