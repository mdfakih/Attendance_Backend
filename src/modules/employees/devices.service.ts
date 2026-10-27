import { Injectable } from '@nestjs/common';
import type { CodePurpose } from '@attendance/contracts';
import { AuditService } from '../../core/audit/audit.service.js';
import { PrincipalService } from '../../core/auth/principal.service.js';
import { RefreshTokenService } from '../../core/auth/refresh-token.service.js';
import { employeeScopeWhere, isInScope } from '../../core/auth/scope.js';
import { requireTenantId, requireTenantUser } from '../../core/context/request-context.js';
import { DbService } from '../../core/database/db.service.js';
import { AppError, notFound } from '../../core/http/app-error.js';
import { QUEUE } from '../../core/queue/queues.js';
import { QueueService } from '../../core/queue/queue.service.js';
import { StorageService } from '../../core/storage/storage.service.js';
import { iso } from '../../common/serialize.js';
import { ActivationCodesService, type IssuedCode } from './activation-codes.service.js';
import { EmployeesService } from './employees.service.js';

@Injectable()
export class DevicesService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly codes: ActivationCodesService,
    private readonly employees: EmployeesService,
    private readonly refresh: RefreshTokenService,
    private readonly principals: PrincipalService,
    private readonly storage: StorageService,
    private readonly queues: QueueService,
  ) {}

  async bindings(status?: 'PENDING' | 'ACTIVE') {
    const rows = await this.db.tenant.deviceBinding.findMany({
      where: { status: status ?? { in: ['PENDING', 'ACTIVE'] }, employee: employeeScopeWhere() },
      include: { employee: { select: { id: true, fullName: true, employeeCode: true, phoneE164: true } } },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    const previous = await this.db.tenant.deviceBinding.findMany({
      where: { androidIdHmac: { in: rows.map((r) => r.androidIdHmac).filter((v): v is string => !!v) }, status: 'REVOKED' },
      select: { androidIdHmac: true, employeeId: true },
    });
    return rows.map((b) => ({
      id: b.id,
      status: b.status,
      employee: b.employee,
      manufacturer: b.manufacturer,
      model: b.model,
      osVersion: b.osVersion,
      appVersion: b.appVersion,
      createdAt: iso(b.createdAt),
      activatedAt: iso(b.activatedAt),
      lastSeenAt: iso(b.lastSeenAt),
      hasActivationSelfie: !!b.activationSelfieKey,
      samePhoneAsBefore: previous.some((p) => p.androidIdHmac === b.androidIdHmac && p.employeeId === b.employeeId),
    }));
  }

  async activationSelfieUrl(bindingId: string): Promise<{ url: string }> {
    const binding = await this.db.tenant.deviceBinding.findUnique({ where: { id: bindingId }, include: { employee: true } });
    if (!binding?.activationSelfieKey || !isInScope(binding.employee)) throw notFound('Selfie');
    await this.audit.record({ action: 'selfie.view', entityType: 'device_binding', entityId: bindingId });
    return { url: await this.storage.presignGet(binding.activationSelfieKey, 300) };
  }

  async approve(bindingId: string) {
    const binding = await this.pending(bindingId);
    await this.db.tenant.$transaction(async (tx) => {
      await tx.deviceBinding.update({
        where: { id: bindingId },
        data: { status: 'ACTIVE', approvedById: requireTenantUser().membershipId, approvedAt: new Date(), activatedAt: new Date() },
      });
      await tx.employee.update({ where: { id: binding.employeeId }, data: { status: 'ACTIVE', activatedAt: new Date() } });
      await this.audit.record({ action: 'device.binding.approved', entityType: 'device_binding', entityId: bindingId }, tx);
    });
    await Promise.all([this.principals.invalidateBinding(bindingId), this.principals.invalidateEmployee(binding.employeeId)]);
    await this.queues.add(QUEUE.NOTIFY, 'push', {
      tenantId: requireTenantId(),
      employeeId: binding.employeeId,
      title: 'Phone approved',
      body: 'Your phone is approved. Open the app to continue.',
      data: { type: 'BINDING_APPROVED', bindingId },
    });
    return { id: bindingId, status: 'ACTIVE' };
  }

  async reject(bindingId: string, note?: string) {
    const binding = await this.pending(bindingId);
    await this.db.tenant.deviceBinding.update({
      where: { id: bindingId },
      data: {
        status: 'REVOKED',
        revokedAt: new Date(),
        revokeReason: 'REJECTED',
        revokedByActor: 'TENANT_USER',
        revokedById: requireTenantUser().membershipId,
        revokeNote: note,
        liveEmployeeId: null,
      },
    });
    await this.refresh.revokeByBinding(bindingId, 'REJECTED');
    await this.principals.invalidateBinding(bindingId);
    await this.audit.record({ action: 'device.binding.rejected', entityType: 'device_binding', entityId: bindingId, reason: note });
    return { id: binding.id, status: 'REVOKED' };
  }

  /** Frees the employee's phone slot and issues a fresh activation code for the new phone. */
  async release(employeeId: string, reason: string): Promise<{ activationCode: IssuedCode }> {
    const employee = await this.db.tenant.employee.findUnique({ where: { id: employeeId } });
    if (!employee || !isInScope(employee)) throw notFound('Employee');
    if (employee.status !== 'ACTIVE' && employee.status !== 'INVITED') {
      throw new AppError('EMPLOYEE_INACTIVE');
    }
    const tenant = await this.employees.tenantInfo();
    const bindings = await this.db.tenant.deviceBinding.findMany({ where: { employeeId, status: { in: ['ACTIVE', 'PENDING'] } } });
    const activationCode = await this.db.tenant.$transaction(async (tx) => {
      await tx.deviceBinding.updateMany({
        where: { employeeId, status: { in: ['ACTIVE', 'PENDING'] } },
        data: {
          status: 'REVOKED',
          revokedAt: new Date(),
          revokeReason: 'RELEASED_BY_EMPLOYER',
          revokedByActor: 'TENANT_USER',
          revokedById: requireTenantUser().membershipId,
          revokeNote: reason,
          liveEmployeeId: null,
        },
      });
      await this.audit.record({ action: 'device.binding.released', entityType: 'employee', entityId: employeeId, reason }, tx);
      return this.codes.issue(tx, { tenantId: tenant.id, employeeId, purpose: 'ACTIVATION', via: 'RELEASE', ttlDays: tenant.codeTtlDays });
    });
    await Promise.all(bindings.map((b) => this.refresh.revokeByBinding(b.id, 'RELEASED')));
    await Promise.all(bindings.map((b) => this.principals.invalidateBinding(b.id)));
    return { activationCode };
  }

  async revealCode(employeeId: string, purpose: CodePurpose): Promise<IssuedCode | null> {
    const employee = await this.db.tenant.employee.findUnique({ where: { id: employeeId } });
    if (!employee || !isInScope(employee)) throw notFound('Employee');
    const code = await this.codes.reveal(employeeId, purpose);
    if (code) {
      await this.audit.record({ action: 'activation_code.revealed', entityType: 'employee', entityId: employeeId, after: { purpose } });
    }
    return code;
  }

  async regenerateCode(employeeId: string, purpose: CodePurpose): Promise<IssuedCode> {
    const employee = await this.db.tenant.employee.findUnique({ where: { id: employeeId } });
    if (!employee || !isInScope(employee)) throw notFound('Employee');
    if (employee.status !== 'ACTIVE' && employee.status !== 'INVITED') throw new AppError('EMPLOYEE_INACTIVE');
    if (purpose === 'PIN_RESET') {
      const active = await this.db.tenant.deviceBinding.count({ where: { employeeId, status: 'ACTIVE' } });
      if (active === 0) throw new AppError('CONFLICT', 'A PIN reset code needs an active phone. Issue an activation code instead.');
    } else {
      const bound = await this.db.tenant.deviceBinding.count({ where: { employeeId, status: { in: ['ACTIVE', 'PENDING'] } } });
      if (bound > 0) throw new AppError('DEVICE_BOUND', 'Release the current phone first.');
    }
    const tenant = await this.employees.tenantInfo();
    return this.db.tenant.$transaction((tx) =>
      this.codes.issue(tx, { tenantId: tenant.id, employeeId, purpose, via: purpose === 'PIN_RESET' ? 'PIN_RESET' : 'REGENERATE', ttlDays: tenant.codeTtlDays }),
    );
  }

  async emailCode(employeeId: string): Promise<void> {
    const employee = await this.db.tenant.employee.findUnique({ where: { id: employeeId } });
    if (!employee || !isInScope(employee)) throw notFound('Employee');
    if (!employee.email) throw new AppError('VALIDATION_FAILED', 'This employee has no email address.');
    await this.queues.add(QUEUE.NOTIFY, 'activation-email', { tenantId: requireTenantId(), employeeId });
    await this.audit.record({ action: 'activation_code.emailed', entityType: 'employee', entityId: employeeId });
  }

  /** Codes for many employees: reveals live codes and issues new ones where missing/expired. */
  async bulkCodes(employeeIds: readonly string[]) {
    const employees = await this.db.tenant.employee.findMany({
      where: { id: { in: [...employeeIds] }, status: { in: ['ACTIVE', 'INVITED'] }, ...employeeScopeWhere() },
      include: { bindings: { where: { status: { in: ['ACTIVE', 'PENDING'] } }, select: { id: true } } },
      orderBy: { fullName: 'asc' },
    });
    const tenant = await this.employees.tenantInfo();
    const rows: Array<{ fullName: string; employeeCode: string | null; phone: string; code: string; expiresAt: Date | null; note: string }> = [];
    for (const e of employees) {
      if (e.bindings.length > 0) {
        rows.push({ fullName: e.fullName, employeeCode: e.employeeCode, phone: e.phoneE164, code: '', expiresAt: null, note: 'Phone already registered' });
        continue;
      }
      const code =
        (await this.codes.reveal(e.id, 'ACTIVATION')) ??
        (await this.db.tenant.$transaction((tx) =>
          this.codes.issue(tx, { tenantId: tenant.id, employeeId: e.id, purpose: 'ACTIVATION', via: 'BULK_XLSX', ttlDays: tenant.codeTtlDays }),
        ));
      rows.push({ fullName: e.fullName, employeeCode: e.employeeCode, phone: e.phoneE164, code: code.formatted, expiresAt: code.expiresAt, note: '' });
    }
    await this.audit.record({ action: 'activation_code.bulk_exported', entityType: 'employee', after: { count: rows.length } });
    return rows;
  }

  private async pending(bindingId: string) {
    const binding = await this.db.tenant.deviceBinding.findUnique({ where: { id: bindingId }, include: { employee: true } });
    if (!binding || !isInScope(binding.employee)) throw notFound('Device');
    if (binding.status !== 'PENDING') throw new AppError('CONFLICT', 'This device is not waiting for approval.');
    return binding;
  }
}
