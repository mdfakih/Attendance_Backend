import { Injectable } from '@nestjs/common';
import type { BranchInput, DepartmentInput, SiteInput } from '@attendance/contracts';
import { AuditService } from '../../core/audit/audit.service.js';
import { requireTenantId } from '../../core/context/request-context.js';
import { DbService } from '../../core/database/db.service.js';
import { AppError, notFound } from '../../core/http/app-error.js';
import { AttendanceDayService } from '../attendance/attendance-day.service.js';
import { addDays, localDateOf } from '../../engines/time/dates.js';

@Injectable()
export class OrgService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly days: AttendanceDayService,
  ) {}

  branches() {
    return this.db.tenant.branch.findMany({
      orderBy: { name: 'asc' },
      include: { _count: { select: { employees: { where: { status: { in: ['ACTIVE', 'INVITED'] } } } } } },
    });
  }

  async createBranch(input: BranchInput) {
    await this.assertRefs(input);
    const branch = await this.db.tenant.branch.create({ data: { ...input, tenantId: requireTenantId(), code: input.code || null } });
    await this.audit.record({ action: 'branch.create', entityType: 'branch', entityId: branch.id, after: branch });
    return branch;
  }

  async updateBranch(id: string, input: BranchInput) {
    await this.assertRefs(input);
    const before = await this.db.tenant.branch.findUnique({ where: { id } });
    if (!before) throw notFound('Branch');
    const after = await this.db.tenant.branch.update({ where: { id }, data: { ...input, code: input.code || null } });
    await this.audit.record({ action: 'branch.update', entityType: 'branch', entityId: id, before, after });
    const calendarChanged =
      before.holidayCalendarId !== after.holidayCalendarId ||
      before.weeklyOffPatternId !== after.weeklyOffPatternId ||
      before.defaultShiftId !== after.defaultShiftId;
    if (calendarChanged) {
      await this.recomputeBranch(id);
    }
    return after;
  }

  departments() {
    return this.db.tenant.department.findMany({ orderBy: { name: 'asc' } });
  }

  async createDepartment(input: DepartmentInput) {
    const dept = await this.db.tenant.department.create({ data: { ...input, tenantId: requireTenantId(), code: input.code || null } });
    await this.audit.record({ action: 'department.create', entityType: 'department', entityId: dept.id, after: dept });
    return dept;
  }

  async updateDepartment(id: string, input: DepartmentInput) {
    const before = await this.db.tenant.department.findUnique({ where: { id } });
    if (!before) throw notFound('Department');
    const after = await this.db.tenant.department.update({ where: { id }, data: { ...input, code: input.code || null } });
    await this.audit.record({ action: 'department.update', entityType: 'department', entityId: id, before, after });
    return after;
  }

  sites() {
    return this.db.tenant.site.findMany({
      orderBy: { name: 'asc' },
      include: { branch: { select: { id: true, name: true } }, _count: { select: { employees: true } } },
    });
  }

  async createSite(input: SiteInput) {
    if (input.branchId) await this.mustExist('branch', input.branchId);
    const site = await this.db.tenant.site.create({ data: { ...input, tenantId: requireTenantId(), branchId: input.branchId ?? null } });
    await this.audit.record({ action: 'site.create', entityType: 'site', entityId: site.id, after: site });
    return site;
  }

  async updateSite(id: string, input: SiteInput) {
    if (input.branchId) await this.mustExist('branch', input.branchId);
    const before = await this.db.tenant.site.findUnique({ where: { id } });
    if (!before) throw notFound('Site');
    const after = await this.db.tenant.site.update({ where: { id }, data: { ...input, branchId: input.branchId ?? null } });
    await this.audit.record({ action: 'site.update', entityType: 'site', entityId: id, before, after });
    return after;
  }

  private async assertRefs(input: BranchInput): Promise<void> {
    if (input.holidayCalendarId) await this.mustExist('holidayCalendar', input.holidayCalendarId);
    if (input.weeklyOffPatternId) await this.mustExist('weeklyOffPattern', input.weeklyOffPatternId);
    if (input.defaultShiftId) await this.mustExist('shift', input.defaultShiftId);
  }

  /** Verifies a referenced row belongs to the caller's tenant (tenant client scopes the lookup). */
  private async mustExist(model: 'branch' | 'holidayCalendar' | 'weeklyOffPattern' | 'shift', id: string): Promise<void> {
    const delegates = {
      branch: () => this.db.tenant.branch.count({ where: { id } }),
      holidayCalendar: () => this.db.tenant.holidayCalendar.count({ where: { id } }),
      weeklyOffPattern: () => this.db.tenant.weeklyOffPattern.count({ where: { id } }),
      shift: () => this.db.tenant.shift.count({ where: { id } }),
    };
    if ((await delegates[model]()) === 0) {
      throw new AppError('VALIDATION_FAILED', `Unknown ${model}.`);
    }
  }

  private async recomputeBranch(branchId: string): Promise<void> {
    const tenantId = requireTenantId();
    const employees = await this.db.tenant.employee.findMany({ where: { branchId, status: 'ACTIVE' }, select: { id: true } });
    if (employees.length === 0) return;
    const tz = (await this.db.platform.tenant.findUniqueOrThrow({ where: { id: tenantId } })).timezone;
    const today = localDateOf(new Date(), tz);
    await this.days.markStale(employees.map((e) => e.id), addDays(today, -31), today);
  }
}
