import { Injectable } from '@nestjs/common';
import type { ManualMarkInput, OvertimeDecisionInput, RevokeMarkInput } from '@attendance/contracts';
import { AuditService } from '../../core/audit/audit.service.js';
import { isInScope } from '../../core/auth/scope.js';
import { currentContext, requireTenantId, requireTenantUser } from '../../core/context/request-context.js';
import { DbService } from '../../core/database/db.service.js';
import { AppError, notFound } from '../../core/http/app-error.js';
import { monthOf, toDbDate } from '../../engines/time/dates.js';
import { AttendanceDayService } from './attendance-day.service.js';

@Injectable()
export class AttendanceMarkService {
  constructor(
    private readonly db: DbService,
    private readonly days: AttendanceDayService,
    private readonly audit: AuditService,
  ) {}

  async mark(input: ManualMarkInput) {
    const employee = await this.employeeInScope(input.employeeId);
    if (input.status === 'LEAVE' && currentContext()?.features?.LEAVE) {
      throw new AppError('CONFLICT', 'Leave management is on. Apply leave on behalf of the employee instead.');
    }
    if (input.leaveTypeId) {
      await this.db.tenant.leaveType.findUniqueOrThrow({ where: { id: input.leaveTypeId } });
    }
    await this.assertMonthOpen(input.date);
    if (input.date < (employee.dateOfJoining.toISOString().slice(0, 10))) {
      throw new AppError('VALIDATION_FAILED', 'The date is before the employee joined.');
    }
    const existing = await this.db.tenant.attendanceDay.findUnique({
      where: { employeeId_attendanceDate: { employeeId: input.employeeId, attendanceDate: toDbDate(input.date) } },
    });
    const mark = await this.db.tenant.attendanceManualMark.create({
      data: {
        employeeId: input.employeeId,
        attendanceDate: toDbDate(input.date),
        tenantId: requireTenantId(),
        action: 'SET',
        status: input.status,
        leaveTypeId: input.leaveTypeId ?? null,
        reason: input.reason,
        previousFinalStatus: existing?.finalStatus ?? null,
        markedById: requireTenantUser().membershipId,
      },
    });
    await this.audit.record({
      action: 'attendance.manual_mark',
      entityType: 'employee',
      entityId: input.employeeId,
      before: { date: input.date, status: existing?.finalStatus ?? null },
      after: { date: input.date, status: input.status },
      reason: input.reason,
    });
    const day = await this.days.recomputeDay(input.employeeId, input.date);
    return { markId: mark.id, status: day?.result.finalStatus ?? input.status };
  }

  async revoke(input: RevokeMarkInput) {
    await this.employeeInScope(input.employeeId);
    await this.assertMonthOpen(input.date);
    const latest = await this.db.tenant.attendanceManualMark.findFirst({
      where: { employeeId: input.employeeId, attendanceDate: toDbDate(input.date) },
      orderBy: { createdAt: 'desc' },
    });
    if (!latest || latest.action === 'REVOKE') {
      throw new AppError('CONFLICT', 'There is no manual mark to remove for this day.');
    }
    await this.db.tenant.attendanceManualMark.create({
      data: {
        employeeId: input.employeeId,
        attendanceDate: toDbDate(input.date),
        tenantId: requireTenantId(),
        action: 'REVOKE',
        reason: input.reason,
        previousFinalStatus: latest.status,
        markedById: requireTenantUser().membershipId,
      },
    });
    await this.audit.record({
      action: 'attendance.manual_mark.revoke',
      entityType: 'employee',
      entityId: input.employeeId,
      before: { date: input.date, status: latest.status },
      reason: input.reason,
    });
    const day = await this.days.recomputeDay(input.employeeId, input.date);
    return { status: day?.result.finalStatus ?? null };
  }

  async decideOvertime(input: OvertimeDecisionInput) {
    await this.employeeInScope(input.employeeId);
    await this.assertMonthOpen(input.date);
    const day = await this.db.tenant.attendanceDay.findUnique({
      where: { employeeId_attendanceDate: { employeeId: input.employeeId, attendanceDate: toDbDate(input.date) } },
    });
    if (!day || day.otMinutes === 0) throw new AppError('CONFLICT', 'There is no overtime on this day.');
    const approved = Math.min(input.approvedMinutes, day.otMinutes);
    await this.db.tenant.attendanceDay.update({
      where: { id: day.id },
      data: {
        otState: approved > 0 ? 'APPROVED' : 'REJECTED',
        otApprovedMinutes: approved,
        otDecidedById: requireTenantUser().membershipId,
        otDecidedAt: new Date(),
        inputsHash: '',
      },
    });
    await this.audit.record({
      action: 'attendance.ot.decide',
      entityType: 'employee',
      entityId: input.employeeId,
      after: { date: input.date, approvedMinutes: approved },
      reason: input.note,
    });
    await this.days.queuePay(requireTenantId(), input.employeeId, monthOf(input.date));
    return { approvedMinutes: approved };
  }

  async pendingOvertime() {
    const rows = await this.db.tenant.attendanceDay.findMany({
      where: { otState: 'PENDING' },
      orderBy: { attendanceDate: 'desc' },
      take: 500,
      include: { employee: { select: { id: true, fullName: true, employeeCode: true, branchId: true, departmentId: true } } },
    });
    return rows
      .filter((r) => isInScope(r.employee))
      .map((r) => ({
        employee: { id: r.employee.id, fullName: r.employee.fullName, employeeCode: r.employee.employeeCode },
        date: r.attendanceDate.toISOString().slice(0, 10),
        workedMinutes: r.workedMinutes,
        otMinutes: r.otMinutes,
      }));
  }

  private async employeeInScope(employeeId: string) {
    const employee = await this.db.tenant.employee.findUnique({ where: { id: employeeId } });
    if (!employee || !isInScope(employee)) throw notFound('Employee');
    return employee;
  }

  private async assertMonthOpen(date: string): Promise<void> {
    const locked = await this.db.tenant.payPeriod.count({ where: { month: toDbDate(`${monthOf(date)}-01`), status: 'LOCKED' } });
    if (locked > 0) throw new AppError('PERIOD_LOCKED');
  }
}
