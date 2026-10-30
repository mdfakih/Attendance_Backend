import { Injectable } from '@nestjs/common';
import { PERMISSION_MODULES, type RoleInput } from '@attendance/contracts';
import { AuditService } from '../../core/audit/audit.service.js';
import { PrincipalService } from '../../core/auth/principal.service.js';
import { DbService } from '../../core/database/db.service.js';
import { AppError, notFound } from '../../core/http/app-error.js';
import { isUniqueViolation } from '../../common/unique-retry.js';

/** Keeps only known modules/actions so stored permissions always match the catalogue. */
export function cleanPermissions(input: RoleInput['permissions']): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(input)
      .filter(([module, actions]) => (PERMISSION_MODULES as readonly string[]).includes(module) && actions.length > 0)
      .map(([module, actions]) => [module, [...new Set(actions)]]),
  );
}

const DUPLICATE_NAME = 'A role with this name already exists.';

/**
 * A client's roles and their permission matrix. Owned by the platform team: a client's Admin
 * can see roles and assign them to users, but only the platform console creates or edits them.
 * Every query names the tenant explicitly because platform requests carry no tenant context.
 */
@Injectable()
export class RolesService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly principals: PrincipalService,
  ) {}

  async list(tenantId: string) {
    const roles = await this.db.platform.role.findMany({
      where: { tenantId },
      orderBy: [{ kind: 'asc' }, { name: 'asc' }],
      include: { _count: { select: { memberships: true } } },
    });
    return roles.map((r) => ({
      id: r.id,
      name: r.name,
      kind: r.kind,
      description: r.description,
      isSystem: r.isSystem,
      permissions: r.permissions,
      members: r._count.memberships,
    }));
  }

  async create(tenantId: string, input: RoleInput) {
    await this.assertTenant(tenantId);
    try {
      const role = await this.db.platform.role.create({
        data: {
          tenantId,
          name: input.name,
          description: input.description,
          kind: 'MANAGER',
          permissions: cleanPermissions(input.permissions),
        },
      });
      await this.audit.record({ action: 'role.create', entityType: 'role', entityId: role.id, after: role, tenantId });
      return role;
    } catch (error: unknown) {
      if (isUniqueViolation(error)) throw new AppError('CONFLICT', DUPLICATE_NAME);
      throw error;
    }
  }

  async update(tenantId: string, roleId: string, input: RoleInput) {
    const before = await this.find(tenantId, roleId);
    if (before.kind === 'ADMIN') {
      throw new AppError('CONFLICT', 'The Admin role always has full access and cannot be edited.');
    }
    try {
      const after = await this.db.platform.role.update({
        where: { id: roleId },
        data: { name: input.name, description: input.description, permissions: cleanPermissions(input.permissions) },
      });
      await this.bumpPermissions(tenantId, roleId);
      await this.audit.record({ action: 'role.update', entityType: 'role', entityId: roleId, before, after, tenantId });
      return after;
    } catch (error: unknown) {
      if (isUniqueViolation(error)) throw new AppError('CONFLICT', DUPLICATE_NAME);
      throw error;
    }
  }

  async remove(tenantId: string, roleId: string): Promise<void> {
    const role = await this.find(tenantId, roleId);
    const [members, invites] = await Promise.all([
      this.db.platform.tenantMembership.count({ where: { tenantId, roleId } }),
      this.db.platform.userInvitation.count({ where: { tenantId, roleId, acceptedAt: null, revokedAt: null } }),
    ]);
    if (role.kind === 'ADMIN') {
      throw new AppError('CONFLICT', 'The Admin role cannot be deleted.');
    }
    if (members > 0 || invites > 0) {
      throw new AppError('CONFLICT', 'Move its users and pending invitations to another role first.');
    }
    await this.db.platform.role.delete({ where: { id: roleId } });
    await this.audit.record({ action: 'role.delete', entityType: 'role', entityId: roleId, before: role, tenantId });
  }

  private async find(tenantId: string, roleId: string) {
    const role = await this.db.platform.role.findFirst({ where: { id: roleId, tenantId } });
    if (!role) throw notFound('Role');
    return role;
  }

  private async assertTenant(tenantId: string): Promise<void> {
    const tenant = await this.db.platform.tenant.findUnique({ where: { id: tenantId }, select: { id: true } });
    if (!tenant) throw notFound('Tenant');
  }

  /** Signed-in users of the role get a fresh token (and the new permissions) on their next request. */
  private async bumpPermissions(tenantId: string, roleId: string): Promise<void> {
    const where = { tenantId, roleId };
    const members = await this.db.platform.tenantMembership.findMany({ where, select: { id: true } });
    await this.db.platform.tenantMembership.updateMany({ where, data: { permVersion: { increment: 1 } } });
    await Promise.all(members.map((m) => this.principals.invalidateMembership(m.id)));
  }
}
