import { Injectable } from '@nestjs/common';
import {
  type EmployeeCreateInput,
  type EmployeeDeactivateInput,
  type EmployeeListQuery,
  type EmployeeUpdateInput,
  hasPermission,
} from '@attendance/contracts';
import { Decimal } from 'decimal.js';
import { AuditService } from '../../core/audit/audit.service.js';
import { PrincipalService } from '../../core/auth/principal.service.js';
import { RefreshTokenService } from '../../core/auth/refresh-token.service.js';
import { employeeScopeWhere, isInScope } from '../../core/auth/scope.js';
import { currentContext, requireTenantId } from '../../core/context/request-context.js';
import { DbService, type TenantTx } from '../../core/database/db.service.js';
import { AppError, notFound } from '../../core/http/app-error.js';
import { QUEUE } from '../../core/queue/queues.js';
import { QueueService } from '../../core/queue/queue.service.js';
import { dateOnly, iso, money } from '../../common/serialize.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { toDbDate } from '../../engines/time/dates.js';
import { ActivationCodesService, type IssuedCode } from './activation-codes.service.js';

export interface TenantInfo {
  readonly id: string;
  readonly timezone: string;
  readonly employeeCap: number | null;
  readonly codeTtlDays: number;
}

const LIVE_STATUSES = ['ACTIVE', 'INVITED'] as const;

function canSeeSalary(): boolean {
  const user = currentContext()?.tenantUser;
  return !!user && (user.roleKind === 'ADMIN' || hasPermission(user.permissions, 'EMPLOYEE_SALARY', 'view'));
}

@Injectable()
export class EmployeesService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly codes: ActivationCodesService,
    private readonly refresh: RefreshTokenService,
    private readonly principals: PrincipalService,
    private readonly queues: QueueService,
  ) {}

  async tenantInfo(): Promise<TenantInfo> {
    const tenantId = requireTenantId();
    const [tenant, settings] = await Promise.all([
      this.db.platform.tenant.findUniqueOrThrow({ where: { id: tenantId } }),
      this.db.tenant.tenantSettings.findUniqueOrThrow({ where: { tenantId } }),
    ]);
    return { id: tenant.id, timezone: tenant.timezone, employeeCap: tenant.employeeCap, codeTtlDays: settings.activationCodeTtlDays };
  }

  async list(query: EmployeeListQuery) {
    const where: Prisma.EmployeeWhereInput = {
      ...employeeScopeWhere(),
      ...(query.status ? { status: query.status } : { status: { in: [...LIVE_STATUSES] } }),
      ...(query.branchId ? { branchId: query.branchId } : {}),
      ...(query.departmentId ? { departmentId: query.departmentId } : {}),
      ...(query.siteId ? { sites: { some: { siteId: query.siteId } } } : {}),
      ...(query.deviceStatus === 'NONE' ? { bindings: { none: { status: { in: ['ACTIVE', 'PENDING'] } } } } : {}),
      ...(query.deviceStatus === 'ACTIVE' || query.deviceStatus === 'PENDING'
        ? { bindings: { some: { status: query.deviceStatus } } }
        : {}),
      ...(query.q
        ? {
            OR: [
              { fullName: { contains: query.q, mode: 'insensitive' } },
              { employeeCode: { contains: query.q, mode: 'insensitive' } },
              { phoneE164: { contains: query.q.replace(/\D/g, '') || query.q } },
              { email: { contains: query.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.db.tenant.employee.findMany({
        where,
        include: {
          branch: { select: { id: true, name: true } },
          department: { select: { id: true, name: true } },
          sites: { include: { site: { select: { id: true, name: true } } } },
          bindings: { where: { status: { in: ['ACTIVE', 'PENDING'] } }, select: { status: true, model: true, lastSeenAt: true } },
          salaryAssignments: { where: { effectiveTo: null }, take: 1, orderBy: { effectiveFrom: 'desc' } },
        },
        orderBy: { fullName: 'asc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.db.tenant.employee.count({ where }),
    ]);
    const showSalary = canSeeSalary();
    const items = rows.map((e) => ({
      id: e.id,
      employeeCode: e.employeeCode,
      fullName: e.fullName,
      phone: e.phoneE164,
      email: e.email,
      designation: e.designation,
      status: e.status,
      dateOfJoining: dateOnly(e.dateOfJoining),
      branch: e.branch,
      department: e.department,
      sites: e.sites.map((s) => s.site),
      device: e.bindings[0]
        ? { status: e.bindings[0].status, model: e.bindings[0].model, lastSeenAt: iso(e.bindings[0].lastSeenAt) }
        : { status: 'NONE' as const, model: null, lastSeenAt: null },
      salary:
        showSalary && e.salaryAssignments[0]
          ? { basis: e.salaryAssignments[0].salaryBasis, amount: money(e.salaryAssignments[0].amount) }
          : null,
    }));
    return { items, total };
  }

  async detail(id: string) {
    const e = await this.db.tenant.employee.findUnique({
      where: { id },
      include: {
        branch: { select: { id: true, name: true } },
        department: { select: { id: true, name: true } },
        sites: { include: { site: { select: { id: true, name: true } } } },
        bindings: { orderBy: { createdAt: 'desc' }, take: 10 },
        shiftAssignments: { orderBy: { effectiveFrom: 'desc' }, take: 5, include: { shift: { select: { id: true, name: true } } } },
        salaryAssignments: { orderBy: { effectiveFrom: 'desc' } },
      },
    });
    if (!e || !isInScope(e)) {
      throw notFound('Employee');
    }
    const liveCode = await this.db.tenant.activationCode.findFirst({
      where: { employeeId: id, status: 'ISSUED' },
      select: { purpose: true, expiresAt: true, failedAttempts: true },
    });
    return {
      id: e.id,
      employeeCode: e.employeeCode,
      fullName: e.fullName,
      phone: e.phoneE164,
      email: e.email,
      designation: e.designation,
      status: e.status,
      branch: e.branch,
      department: e.department,
      dateOfJoining: dateOnly(e.dateOfJoining),
      exitDate: dateOnly(e.exitDate),
      exitReason: e.exitReason,
      geofenceMode: e.geofenceMode,
      weeklyOffPatternId: e.weeklyOffPatternId,
      policyId: e.policyId,
      dutyMinutes: e.dutyMinutes,
      sites: e.sites.map((s) => s.site),
      shifts: e.shiftAssignments.map((a) => ({
        id: a.id,
        shift: a.shift,
        effectiveFrom: dateOnly(a.effectiveFrom),
        effectiveTo: dateOnly(a.effectiveTo),
      })),
      devices: e.bindings.map((b) => ({
        id: b.id,
        status: b.status,
        manufacturer: b.manufacturer,
        model: b.model,
        osVersion: b.osVersion,
        appVersion: b.appVersion,
        activatedAt: iso(b.activatedAt),
        lastSeenAt: iso(b.lastSeenAt),
        revokedAt: iso(b.revokedAt),
        revokeReason: b.revokeReason,
        hasActivationSelfie: !!b.activationSelfieKey,
      })),
      activationCode: liveCode
        ? { purpose: liveCode.purpose, expiresAt: iso(liveCode.expiresAt), expired: liveCode.expiresAt < new Date() }
        : null,
      salaryHistory: canSeeSalary()
        ? e.salaryAssignments.map((s) => ({
            id: s.id,
            basis: s.salaryBasis,
            amount: money(s.amount),
            effectiveFrom: dateOnly(s.effectiveFrom),
            effectiveTo: dateOnly(s.effectiveTo),
            otMultiplier: money(s.otMultiplier),
            reason: s.revisionReason,
          }))
        : null,
    };
  }

  async create(input: EmployeeCreateInput): Promise<{ id: string; activationCode: IssuedCode }> {
    const tenant = await this.tenantInfo();
    await this.assertCapacity(tenant, 1);
    await this.assertRefs(input);
    await this.assertPhoneAvailable(input.phone);
    if (input.employeeCode) await this.assertCodeAvailable(tenant.id, input.employeeCode);
    const result = await this.db.tenant.$transaction((tx) => this.createInTx(tx, tenant, input, 'SINGLE'));
    await this.afterCreate(result.id);
    return result;
  }

  /** Shared by single create and bulk import commit. */
  async createInTx(
    tx: TenantTx,
    tenant: TenantInfo,
    input: EmployeeCreateInput,
    via: 'SINGLE' | 'IMPORT',
  ): Promise<{ id: string; activationCode: IssuedCode }> {
    const membershipId = currentContext()?.tenantUser?.membershipId ?? null;
    const employee = await tx.employee.create({
      data: {
        tenantId: tenant.id,
        employeeCode: input.employeeCode || null,
        fullName: input.fullName,
        phoneE164: input.phone,
        email: input.email ?? null,
        designation: input.designation ?? null,
        branchId: input.branchId,
        departmentId: input.departmentId ?? null,
        dateOfJoining: toDbDate(input.dateOfJoining),
        geofenceMode: input.geofenceMode,
        weeklyOffPatternId: input.weeklyOffPatternId ?? null,
        dutyMinutes: input.dutyMinutes ?? null,
        createdVia: via,
        livePhone: input.phone,
        liveCodeKey: input.employeeCode ? `${tenant.id}:${input.employeeCode.toUpperCase()}` : null,
      },
    });
    if (input.siteIds.length > 0) {
      await tx.employeeSite.createMany({
        data: input.siteIds.map((siteId) => ({ tenantId: tenant.id, employeeId: employee.id, siteId })),
      });
    }
    if (input.shiftId) {
      await tx.shiftAssignment.create({
        data: {
          tenantId: tenant.id,
          employeeId: employee.id,
          shiftId: input.shiftId,
          effectiveFrom: toDbDate(input.dateOfJoining),
          createdById: membershipId,
        },
      });
    }
    if (input.salary) {
      await tx.employeeSalaryAssignment.create({
        data: {
          tenantId: tenant.id,
          employeeId: employee.id,
          salaryBasis: input.salary.basis,
          amount: new Decimal(input.salary.amount),
          effectiveFrom: toDbDate(input.salary.effectiveFrom),
          otMultiplier: input.salary.otMultiplier ? new Decimal(input.salary.otMultiplier) : null,
          revisionReason: input.salary.revisionReason || 'Initial salary',
          createdById: membershipId,
        },
      });
    }
    const activationCode = await this.codes.issue(tx, {
      tenantId: tenant.id,
      employeeId: employee.id,
      purpose: 'ACTIVATION',
      via: via === 'IMPORT' ? 'BULK_XLSX' : 'CREATE',
      ttlDays: tenant.codeTtlDays,
    });
    await this.audit.record(
      { action: 'employee.create', entityType: 'employee', entityId: employee.id, after: { ...employee, livePhone: undefined } },
      tx,
    );
    return { id: employee.id, activationCode };
  }

  async afterCreate(employeeId: string): Promise<void> {
    const ctx = currentContext();
    if (ctx?.features?.AUTO_EMAIL_ACTIVATION_CODES && ctx.tenantId) {
      await this.queues.add(QUEUE.NOTIFY, 'activation-email', { tenantId: ctx.tenantId, employeeId });
    }
  }

  async update(id: string, input: EmployeeUpdateInput) {
    const tenantId = requireTenantId();
    const before = await this.db.tenant.employee.findUnique({ where: { id }, include: { sites: true } });
    if (!before || !isInScope(before)) throw notFound('Employee');
    await this.assertRefs(input);
    const live = before.status === 'ACTIVE' || before.status === 'INVITED';
    if (input.phone && input.phone !== before.phoneE164) {
      await this.assertPhoneAvailable(input.phone);
    }
    if (input.employeeCode && input.employeeCode !== before.employeeCode) {
      await this.assertCodeAvailable(tenantId, input.employeeCode);
    }
    const after = await this.db.tenant.$transaction(async (tx) => {
      const updated = await tx.employee.update({
        where: { id },
        data: {
          employeeCode: input.employeeCode === undefined ? undefined : input.employeeCode || null,
          fullName: input.fullName,
          phoneE164: input.phone,
          livePhone: input.phone && live ? input.phone : undefined,
          liveCodeKey:
            input.employeeCode === undefined ? undefined : input.employeeCode ? `${tenantId}:${input.employeeCode.toUpperCase()}` : null,
          email: input.email,
          designation: input.designation,
          branchId: input.branchId,
          departmentId: input.departmentId,
          dateOfJoining: input.dateOfJoining ? toDbDate(input.dateOfJoining) : undefined,
          geofenceMode: input.geofenceMode,
          weeklyOffPatternId: input.weeklyOffPatternId,
          dutyMinutes: input.dutyMinutes,
        },
      });
      if (input.siteIds) {
        await tx.employeeSite.deleteMany({ where: { employeeId: id } });
        if (input.siteIds.length > 0) {
          await tx.employeeSite.createMany({ data: input.siteIds.map((siteId) => ({ tenantId, employeeId: id, siteId })) });
        }
      }
      if (input.shiftId) {
        const today = toDbDate(new Date().toISOString().slice(0, 10));
        await tx.shiftAssignment.updateMany({ where: { employeeId: id, effectiveTo: null }, data: { effectiveTo: today } });
        await tx.shiftAssignment.create({ data: { tenantId, employeeId: id, shiftId: input.shiftId, effectiveFrom: today } });
      }
      await this.audit.record({ action: 'employee.update', entityType: 'employee', entityId: id, before, after: updated }, tx);
      return updated;
    });
    await this.principals.invalidateEmployee(id);
    return { id: after.id };
  }

  async deactivate(id: string, input: EmployeeDeactivateInput) {
    const employee = await this.db.tenant.employee.findUnique({ where: { id } });
    if (!employee || !isInScope(employee)) throw notFound('Employee');
    if (employee.status === 'EXITED' || employee.status === 'DEACTIVATED') {
      throw new AppError('CONFLICT', 'Employee is already inactive.');
    }
    const bindings = await this.db.tenant.deviceBinding.findMany({ where: { employeeId: id, status: { in: ['ACTIVE', 'PENDING'] } } });
    await this.db.tenant.$transaction(async (tx) => {
      await tx.employee.update({
        where: { id },
        data: {
          status: input.exited ? 'EXITED' : 'DEACTIVATED',
          exitDate: input.exitDate ? toDbDate(input.exitDate) : null,
          exitReason: input.reason,
          deactivatedAt: new Date(),
          livePhone: null,
          liveCodeKey: input.exited ? null : employee.liveCodeKey,
        },
      });
      await tx.deviceBinding.updateMany({
        where: { employeeId: id, status: { in: ['ACTIVE', 'PENDING'] } },
        data: {
          status: 'REVOKED',
          revokedAt: new Date(),
          revokeReason: input.exited ? 'EMPLOYEE_EXITED' : 'EMPLOYEE_DEACTIVATED',
          liveEmployeeId: null,
        },
      });
      await this.codes.revokeAll(tx, id);
      await this.audit.record(
        { action: input.exited ? 'employee.exit' : 'employee.deactivate', entityType: 'employee', entityId: id, reason: input.reason },
        tx,
      );
    });
    await this.refresh.revokeBySubject('EMPLOYEE', id, 'DEACTIVATED');
    await Promise.all([this.principals.invalidateEmployee(id), ...bindings.map((b) => this.principals.invalidateBinding(b.id))]);
    return { id, status: input.exited ? 'EXITED' : 'DEACTIVATED' };
  }

  async reactivate(id: string): Promise<{ id: string; activationCode: IssuedCode }> {
    const employee = await this.db.tenant.employee.findUnique({ where: { id } });
    if (!employee || !isInScope(employee)) throw notFound('Employee');
    if (employee.status !== 'DEACTIVATED') {
      throw new AppError('CONFLICT', 'Only deactivated employees can be reactivated.');
    }
    const tenant = await this.tenantInfo();
    await this.assertCapacity(tenant, 1);
    await this.assertPhoneAvailable(employee.phoneE164);
    const activationCode = await this.db.tenant.$transaction(async (tx) => {
      await tx.employee.update({
        where: { id },
        data: { status: 'INVITED', livePhone: employee.phoneE164, deactivatedAt: null, exitDate: null, exitReason: null },
      });
      await this.audit.record({ action: 'employee.reactivate', entityType: 'employee', entityId: id }, tx);
      return this.codes.issue(tx, { tenantId: tenant.id, employeeId: id, purpose: 'ACTIVATION', via: 'REGENERATE', ttlDays: tenant.codeTtlDays });
    });
    await this.principals.invalidateEmployee(id);
    return { id, activationCode };
  }

  async assertCapacity(tenant: TenantInfo, adding: number): Promise<void> {
    if (tenant.employeeCap === null) return;
    const live = await this.db.tenant.employee.count({ where: { status: { in: [...LIVE_STATUSES] } } });
    if (live + adding > tenant.employeeCap) {
      throw new AppError('PLAN_LIMIT', `Your plan allows ${tenant.employeeCap} employees.`);
    }
  }

  async assertPhoneAvailable(phone: string): Promise<void> {
    const taken = await this.db.platform.employee.count({ where: { livePhone: phone } });
    if (taken > 0) throw new AppError('PHONE_UNAVAILABLE');
  }

  async assertCodeAvailable(tenantId: string, code: string): Promise<void> {
    const taken = await this.db.platform.employee.count({ where: { liveCodeKey: `${tenantId}:${code.toUpperCase()}` } });
    if (taken > 0) throw new AppError('EMPLOYEE_CODE_TAKEN');
  }

  private async assertRefs(input: Partial<EmployeeCreateInput>): Promise<void> {
    const checks: Array<Promise<boolean>> = [];
    if (input.branchId) checks.push(this.db.tenant.branch.count({ where: { id: input.branchId } }).then((n) => n === 1));
    if (input.departmentId) checks.push(this.db.tenant.department.count({ where: { id: input.departmentId } }).then((n) => n === 1));
    if (input.shiftId) checks.push(this.db.tenant.shift.count({ where: { id: input.shiftId } }).then((n) => n === 1));
    if (input.weeklyOffPatternId) {
      checks.push(this.db.tenant.weeklyOffPattern.count({ where: { id: input.weeklyOffPatternId } }).then((n) => n === 1));
    }
    if (input.siteIds?.length) {
      checks.push(this.db.tenant.site.count({ where: { id: { in: input.siteIds } } }).then((n) => n === input.siteIds?.length));
    }
    const results = await Promise.all(checks);
    if (results.some((ok) => !ok)) {
      throw new AppError('VALIDATION_FAILED', 'A selected branch, department, shift, weekly-off pattern or site does not exist.');
    }
  }
}
