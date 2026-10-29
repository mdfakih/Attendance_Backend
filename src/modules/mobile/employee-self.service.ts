import { Injectable } from '@nestjs/common';
import type { ConsentAcceptInput } from '@attendance/contracts';
import { AuditService } from '../../core/audit/audit.service.js';
import { PrincipalService } from '../../core/auth/principal.service.js';
import { requireContext, requireEmployee, requireTenantId } from '../../core/context/request-context.js';
import { DbService } from '../../core/database/db.service.js';
import { AppError } from '../../core/http/app-error.js';
import { dateOnly, iso } from '../../common/serialize.js';
import { AttendanceQueryService } from '../attendance/attendance-query.service.js';
import { HousekeepingService } from '../housekeeping/housekeeping.service.js';

@Injectable()
export class EmployeeSelfService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly principals: PrincipalService,
    private readonly attendance: AttendanceQueryService,
    private readonly housekeeping: HousekeepingService,
  ) {}

  async me() {
    const { employeeId, bindingId } = requireEmployee();
    const tenantId = requireTenantId();
    this.housekeeping.ensureToday();
    const [employee, tenant, binding, notice] = await Promise.all([
      this.db.tenant.employee.findUniqueOrThrow({
        where: { id: employeeId },
        include: { branch: { select: { name: true } }, department: { select: { name: true } }, sites: { include: { site: { select: { id: true, name: true } } } } },
      }),
      this.db.platform.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { displayName: true, timezone: true } }),
      this.db.tenant.deviceBinding.findUnique({ where: { id: bindingId }, select: { model: true, manufacturer: true, activatedAt: true } }),
      this.currentNotice(),
    ]);
    const consent = await this.db.tenant.consentRecord.findFirst({
      where: { subjectType: 'EMPLOYEE', subjectId: employeeId },
      orderBy: { createdAt: 'desc' },
    });
    const consentOk = consent?.action === 'GRANT' && (!notice || consent.noticeId === notice.id);
    return {
      employee: {
        id: employee.id,
        fullName: employee.fullName,
        employeeCode: employee.employeeCode,
        phone: employee.phoneE164,
        designation: employee.designation,
        branch: employee.branch.name,
        department: employee.department?.name ?? null,
        dateOfJoining: dateOnly(employee.dateOfJoining),
        sites: employee.sites.map((s) => s.site),
      },
      company: { name: tenant.displayName, timezone: tenant.timezone },
      device: binding && { model: `${binding.manufacturer} ${binding.model}`.trim(), activatedAt: iso(binding.activatedAt) },
      features: requireContext().features,
      consent: { required: !consentOk, notice: notice && { id: notice.id, title: notice.title, bodyMd: notice.bodyMd, purposes: notice.purposes, version: notice.version } },
    };
  }

  async acceptConsent(input: ConsentAcceptInput) {
    const { employeeId, bindingId } = requireEmployee();
    const notice = await this.currentNotice();
    if (!notice || notice.id !== input.noticeId) throw new AppError('VALIDATION_FAILED', 'This notice is no longer current.');
    const required = (notice.purposes as Array<{ code: string; required: boolean }>).filter((p) => p.required).map((p) => p.code);
    if (!required.every((code) => input.purposes.includes(code))) {
      throw new AppError('VALIDATION_FAILED', 'All required purposes must be accepted.');
    }
    await this.db.tenant.consentRecord.create({
      data: { tenantId: requireTenantId(), subjectType: 'EMPLOYEE', subjectId: employeeId, noticeId: notice.id, action: 'GRANT', purposes: input.purposes, method: 'APP', bindingId },
    });
    await this.audit.record({ action: 'consent.grant', entityType: 'employee', entityId: employeeId, after: { noticeId: notice.id } });
    await this.principals.invalidateEmployee(employeeId);
    return { ok: true };
  }

  month(month: string) {
    return this.attendance.monthView(requireEmployee().employeeId, month);
  }

  async day(date: string) {
    const { employeeId } = requireEmployee();
    const detail = await this.attendance.dayDetail(employeeId, date, true);
    return { ...detail, manualMarks: detail.manualMarks.map((m) => ({ status: m.status, action: m.action, createdAt: m.createdAt })) };
  }

  async holidays(year: number) {
    const { employeeId } = requireEmployee();
    const employee = await this.db.tenant.employee.findUniqueOrThrow({ where: { id: employeeId }, include: { branch: true } });
    const settings = await this.db.tenant.tenantSettings.findUnique({ where: { tenantId: requireTenantId() } });
    const calendarId = employee.branch.holidayCalendarId ?? settings?.defaultCalendarId;
    if (!calendarId) return [];
    const rows = await this.db.tenant.holiday.findMany({
      where: { calendarId, holidayDate: { gte: new Date(`${year}-01-01`), lte: new Date(`${year}-12-31`) } },
      orderBy: { holidayDate: 'asc' },
    });
    return rows.map((h) => ({ date: dateOnly(h.holidayDate), name: h.name, kind: h.kind, isPaid: h.isPaid }));
  }

  async notifications() {
    const { employeeId } = requireEmployee();
    const rows = await this.db.tenant.notification.findMany({
      where: { recipientType: 'EMPLOYEE', recipientId: employeeId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return rows.map((n) => ({ id: n.id, type: n.type, title: n.title, body: n.body, data: n.data, createdAt: iso(n.createdAt), readAt: iso(n.readAt) }));
  }

  async markRead(id: string) {
    const { employeeId } = requireEmployee();
    await this.db.tenant.notification.updateMany({ where: { id, recipientId: employeeId, readAt: null }, data: { readAt: new Date() } });
  }

  private currentNotice() {
    const tenantId = requireTenantId();
    return this.db.platform.consentNotice.findFirst({
      where: { audience: 'EMPLOYEE', publishedAt: { not: null }, retiredAt: null, OR: [{ tenantId }, { tenantId: null }] },
      orderBy: [{ tenantId: { sort: 'desc', nulls: 'last' } }, { version: 'desc' }],
    });
  }
}
