import { Inject, Injectable } from '@nestjs/common';
import { PERMISSION_MODULES, type InviteUserInput, type RoleInput, type UpdateMembershipInput } from '@attendance/contracts';
import { AuditService } from '../../core/audit/audit.service.js';
import { PrincipalService } from '../../core/auth/principal.service.js';
import { RefreshTokenService } from '../../core/auth/refresh-token.service.js';
import { ENV, type Env } from '../../core/config/env.js';
import { requireTenantId, requireTenantUser } from '../../core/context/request-context.js';
import { randomToken, sha256Hex } from '../../core/crypto/crypto.util.js';
import { DbService } from '../../core/database/db.service.js';
import { AppError, notFound } from '../../core/http/app-error.js';
import { QUEUE } from '../../core/queue/queues.js';
import { QueueService } from '../../core/queue/queue.service.js';
import { iso } from '../../common/serialize.js';

const INVITE_DAYS = 7;

/** Keeps only known modules/actions so stored permissions always match the catalogue. */
function cleanPermissions(input: RoleInput['permissions']): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(input)
      .filter(([module, actions]) => (PERMISSION_MODULES as readonly string[]).includes(module) && actions.length > 0)
      .map(([module, actions]) => [module, [...new Set(actions)]]),
  );
}

@Injectable()
export class UsersService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly principals: PrincipalService,
    private readonly refresh: RefreshTokenService,
    private readonly queues: QueueService,
  ) {}

  async roles() {
    const roles = await this.db.tenant.role.findMany({
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

  async createRole(input: RoleInput) {
    const role = await this.db.tenant.role.create({
      data: {
        tenantId: requireTenantId(),
        name: input.name,
        description: input.description,
        kind: 'MANAGER',
        permissions: cleanPermissions(input.permissions),
      },
    });
    await this.audit.record({ action: 'role.create', entityType: 'role', entityId: role.id, after: role });
    return role;
  }

  async updateRole(roleId: string, input: RoleInput) {
    const before = await this.db.tenant.role.findUnique({ where: { id: roleId } });
    if (!before) throw notFound('Role');
    if (before.kind === 'ADMIN') {
      throw new AppError('CONFLICT', 'The Admin role always has full access and cannot be edited.');
    }
    const after = await this.db.tenant.role.update({
      where: { id: roleId },
      data: { name: input.name, description: input.description, permissions: cleanPermissions(input.permissions) },
    });
    await this.bumpPermissions({ roleId });
    await this.audit.record({ action: 'role.update', entityType: 'role', entityId: roleId, before, after });
    return after;
  }

  async deleteRole(roleId: string) {
    const role = await this.db.tenant.role.findUnique({ where: { id: roleId }, include: { _count: { select: { memberships: true } } } });
    if (!role) throw notFound('Role');
    if (role.kind === 'ADMIN' || role._count.memberships > 0) {
      throw new AppError('CONFLICT', 'Move its users to another role first.');
    }
    await this.db.tenant.role.delete({ where: { id: roleId } });
    await this.audit.record({ action: 'role.delete', entityType: 'role', entityId: roleId, before: role });
  }

  async users() {
    const [members, invites] = await Promise.all([
      this.db.tenant.tenantMembership.findMany({
        include: { user: { select: { email: true, fullName: true, lastLoginAt: true } }, role: { select: { id: true, name: true, kind: true } } },
        orderBy: { createdAt: 'asc' },
      }),
      this.db.tenant.userInvitation.findMany({ where: { acceptedAt: null, revokedAt: null }, orderBy: { createdAt: 'desc' } }),
    ]);
    return {
      members: members.map((m) => ({
        membershipId: m.id,
        email: m.user.email,
        fullName: m.user.fullName,
        role: m.role,
        status: m.status,
        branchIds: m.branchIds,
        departmentIds: m.departmentIds,
        lastLoginAt: iso(m.user.lastLoginAt),
      })),
      invitations: invites.map((i) => ({
        id: i.id,
        email: i.email,
        fullName: i.fullName,
        roleId: i.roleId,
        expiresAt: iso(i.expiresAt),
        expired: i.expiresAt < new Date(),
      })),
    };
  }

  async invite(input: InviteUserInput) {
    const tenantId = requireTenantId();
    await this.db.tenant.role.findUniqueOrThrow({ where: { id: input.roleId } });
    const user = await this.db.platform.user.findUnique({ where: { email: input.email } });
    if (user) {
      const member = await this.db.tenant.tenantMembership.findFirst({ where: { userId: user.id } });
      if (member) throw new AppError('CONFLICT', 'This person is already a user of your company.');
    }
    await this.db.tenant.userInvitation.updateMany({
      where: { email: input.email, acceptedAt: null, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    const token = randomToken(32);
    const invite = await this.db.tenant.userInvitation.create({
      data: {
        tenantId,
        email: input.email,
        fullName: input.fullName,
        roleId: input.roleId,
        branchIds: input.branchIds,
        departmentIds: input.departmentIds,
        tokenHash: sha256Hex(token),
        invitedById: requireTenantUser().membershipId,
        expiresAt: new Date(Date.now() + INVITE_DAYS * 86_400_000),
      },
    });
    await this.sendInvite(tenantId, input.email, input.fullName, token);
    await this.audit.record({ action: 'user.invite', entityType: 'invitation', entityId: invite.id, after: { email: input.email, roleId: input.roleId } });
    return { id: invite.id };
  }

  async resendInvite(invitationId: string) {
    const invite = await this.db.tenant.userInvitation.findUnique({ where: { id: invitationId } });
    if (!invite || invite.acceptedAt || invite.revokedAt) throw notFound('Invitation');
    const token = randomToken(32);
    await this.db.tenant.userInvitation.update({
      where: { id: invitationId },
      data: { tokenHash: sha256Hex(token), expiresAt: new Date(Date.now() + INVITE_DAYS * 86_400_000) },
    });
    await this.sendInvite(invite.tenantId, invite.email, invite.fullName, token);
  }

  async revokeInvite(invitationId: string) {
    await this.db.tenant.userInvitation.updateMany({ where: { id: invitationId, acceptedAt: null }, data: { revokedAt: new Date() } });
    await this.audit.record({ action: 'user.invite.revoke', entityType: 'invitation', entityId: invitationId });
  }

  async updateMembership(membershipId: string, input: UpdateMembershipInput) {
    const before = await this.db.tenant.tenantMembership.findUnique({ where: { id: membershipId }, include: { role: true } });
    if (!before) throw notFound('User');
    const targetRole = input.roleId ? await this.db.tenant.role.findUniqueOrThrow({ where: { id: input.roleId } }) : before.role;
    const losesAdmin = before.role.kind === 'ADMIN' && (targetRole.kind !== 'ADMIN' || input.status === 'DISABLED');
    if (losesAdmin) {
      const admins = await this.db.tenant.tenantMembership.count({ where: { status: 'ACTIVE', role: { kind: 'ADMIN' } } });
      if (admins <= 1) throw new AppError('LAST_ADMIN');
    }
    const after = await this.db.tenant.tenantMembership.update({
      where: { id: membershipId },
      data: {
        roleId: input.roleId,
        status: input.status,
        branchIds: input.branchIds,
        departmentIds: input.departmentIds,
        permVersion: { increment: 1 },
      },
    });
    await this.principals.invalidateMembership(membershipId);
    if (input.status === 'DISABLED') {
      await this.refresh.revokeBySubject('TENANT_USER', membershipId, 'DISABLED');
    }
    await this.audit.record({ action: 'user.update', entityType: 'membership', entityId: membershipId, before, after });
    return { membershipId, status: after.status };
  }

  private async bumpPermissions(where: { roleId: string }): Promise<void> {
    const members = await this.db.tenant.tenantMembership.findMany({ where, select: { id: true } });
    await this.db.tenant.tenantMembership.updateMany({ where, data: { permVersion: { increment: 1 } } });
    await Promise.all(members.map((m) => this.principals.invalidateMembership(m.id)));
  }

  private async sendInvite(tenantId: string, email: string, fullName: string, token: string): Promise<void> {
    const tenant = await this.db.platform.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { displayName: true } });
    await this.queues.add(QUEUE.NOTIFY, 'email', {
      tenantId,
      to: email,
      subject: `You're invited to ${tenant.displayName}`,
      text: `Hello ${fullName},\n\nYou have been invited to ${tenant.displayName}'s attendance dashboard.\nAccept within ${INVITE_DAYS} days:\n${this.env.WEB_APP_URL}/accept-invite?token=${token}\n`,
    });
  }
}
