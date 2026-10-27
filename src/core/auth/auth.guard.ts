import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthRealm } from '@attendance/contracts';
import type { Request } from 'express';
import { updateContext } from '../context/request-context.js';
import { AppError } from '../http/app-error.js';
import { ALLOW_SUSPENDED, ALLOW_WITHOUT_CONSENT, IS_PUBLIC, REALM } from './decorators.js';
import { PrincipalService } from './principal.service.js';
import { TokenService } from './token.service.js';

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function bearerToken(request: Request): string {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    throw new AppError('UNAUTHENTICATED');
  }
  return header.slice('Bearer '.length).trim();
}

/**
 * Global guard: every route is either @Public or belongs to exactly one realm. Verifies the
 * realm's access token, loads the principal and fills the request context.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly principals: PrincipalService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) {
      return true;
    }
    const realm = this.reflector.getAllAndOverride<AuthRealm>(REALM, targets);
    if (!realm) {
      throw new AppError('FORBIDDEN', 'Route is missing an auth realm.');
    }
    const request = context.switchToHttp().getRequest<Request>();
    const token = bearerToken(request);
    if (realm === 'TENANT_USER') {
      await this.tenantUser(token, request, this.reflector.getAllAndOverride<boolean>(ALLOW_SUSPENDED, targets));
    } else if (realm === 'EMPLOYEE') {
      await this.employee(token, this.reflector.getAllAndOverride<boolean>(ALLOW_WITHOUT_CONSENT, targets));
    } else {
      await this.platformUser(token);
    }
    return true;
  }

  private async tenantUser(token: string, request: Request, allowSuspended: boolean): Promise<void> {
    const claims = await this.tokens.verify('TENANT_USER', token);
    const [user, status, features] = await Promise.all([
      this.principals.tenantUser(claims.sub, claims.tid),
      this.principals.tenantStatus(claims.tid),
      this.principals.features(claims.tid),
    ]);
    if (user.permVersion !== claims.pv) {
      throw new AppError('PERMISSIONS_CHANGED');
    }
    if (status === 'CANCELLED') {
      throw new AppError('TENANT_SUSPENDED');
    }
    if (status === 'SUSPENDED' && !READ_METHODS.has(request.method) && !allowSuspended) {
      throw new AppError('TENANT_SUSPENDED');
    }
    updateContext({
      realm: 'TENANT_USER',
      tenantId: claims.tid,
      actor: { type: 'TENANT_USER', id: user.membershipId, name: user.fullName },
      tenantUser: {
        membershipId: user.membershipId,
        userId: user.userId,
        roleId: user.roleId,
        roleKind: user.roleKind,
        permissions: user.permissions,
        branchIds: user.branchIds,
        departmentIds: user.departmentIds,
      },
      features,
    });
  }

  private async employee(token: string, allowWithoutConsent: boolean): Promise<void> {
    const claims = await this.tokens.verify('EMPLOYEE', token);
    const [active, employee, status, features] = await Promise.all([
      this.principals.bindingActive(claims.bid, claims.sub),
      this.principals.employee(claims.sub, claims.tid),
      this.principals.tenantStatus(claims.tid),
      this.principals.features(claims.tid),
    ]);
    if (!active) {
      throw new AppError('BINDING_INACTIVE');
    }
    if (!employee.active) {
      throw new AppError('EMPLOYEE_INACTIVE');
    }
    if (status === 'SUSPENDED' || status === 'CANCELLED') {
      throw new AppError('TENANT_SUSPENDED');
    }
    if (!employee.consentAcceptedAt && !allowWithoutConsent) {
      throw new AppError('CONSENT_REQUIRED');
    }
    updateContext({
      realm: 'EMPLOYEE',
      tenantId: claims.tid,
      actor: { type: 'EMPLOYEE', id: claims.sub, name: employee.fullName },
      employee: { employeeId: claims.sub, bindingId: claims.bid },
      features,
    });
  }

  private async platformUser(token: string): Promise<void> {
    const claims = await this.tokens.verify('PLATFORM_USER', token);
    const user = await this.principals.platformUser(claims.sub);
    updateContext({
      realm: 'PLATFORM_USER',
      actor: { type: 'PLATFORM_USER', id: user.id, name: user.fullName },
      platform: { platformUserId: user.id, role: user.role },
    });
  }
}
