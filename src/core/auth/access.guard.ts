import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { type FeatureKey, hasPermission, type PlatformRole } from '@attendance/contracts';
import { currentContext } from '../context/request-context.js';
import { AppError } from '../http/app-error.js';
import { ADMIN_ONLY, FEATURE, PERMISSION, type PermissionRequirement, PLATFORM_ROLES } from './decorators.js';

/** Runs after AuthGuard: permission matrix, admin-only, platform roles and feature switches. */
@Injectable()
export class AccessGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];
    const ctx = currentContext();
    const feature = this.reflector.getAllAndOverride<FeatureKey>(FEATURE, targets);
    if (feature && ctx?.features && !ctx.features[feature]) {
      throw new AppError('FEATURE_DISABLED');
    }

    const platformRoles = this.reflector.getAllAndOverride<PlatformRole[]>(PLATFORM_ROLES, targets);
    if (platformRoles?.length && !(ctx?.platform && platformRoles.includes(ctx.platform.role))) {
      throw new AppError('FORBIDDEN');
    }

    const user = ctx?.tenantUser;
    if (!user) {
      return true;
    }
    if (this.reflector.getAllAndOverride<boolean>(ADMIN_ONLY, targets) && user.roleKind !== 'ADMIN') {
      throw new AppError('FORBIDDEN');
    }
    const required = this.reflector.getAllAndOverride<PermissionRequirement>(PERMISSION, targets);
    if (required && user.roleKind !== 'ADMIN' && !hasPermission(user.permissions, required.module, required.action)) {
      throw new AppError('FORBIDDEN');
    }
    return true;
  }
}
