import { Injectable } from '@nestjs/common';
import type {
  DayOverrideInput,
  HolidayCalendarInput,
  HolidayInput,
  PolicyInput,
  ShiftAssignmentInput,
  ShiftInput,
  WeeklyOffPatternInput,
} from '@attendance/contracts';
import { AuditService } from '../../core/audit/audit.service.js';
import { requireTenantId, requireTenantUser } from '../../core/context/request-context.js';
import { DbService } from '../../core/database/db.service.js';
import { AppError, notFound } from '../../core/http/app-error.js';
import { AttendanceDayService } from '../attendance/attendance-day.service.js';
import { dateOnly } from '../../common/serialize.js';
import { addDays, localDateOf, minDate, toDbDate } from '../../engines/time/dates.js';

@Injectable()
export class TimeService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly days: AttendanceDayService,
  ) {}

  // ---- Policies --------------------------------------------------------------

  policies() {
    return this.db.tenant.attendancePolicy.findMany({ orderBy: { name: 'asc' } });
  }

  async createPolicy(input: PolicyInput) {
    const policy = await this.db.tenant.attendancePolicy.create({
      data: { ...input, tenantId: requireTenantId(), fullDayMinMinutes: input.fullDayMinMinutes ?? null },
    });
    await this.audit.record({ action: 'policy.create', entityType: 'policy', entityId: policy.id, after: policy });
    return policy;
  }

  async updatePolicy(id: string, input: PolicyInput) {
    const before = await this.db.tenant.attendancePolicy.findUnique({ where: { id } });
    if (!before) throw notFound('Policy');
    const after = await this.db.tenant.attendancePolicy.update({
      where: { id },
      data: { ...input, fullDayMinMinutes: input.fullDayMinMinutes ?? null, version: { increment: 1 } },
    });
    await this.audit.record({ action: 'policy.update', entityType: 'policy', entityId: id, before, after });
    await this.recompute('ALL');
    return after;
  }

  // ---- Shifts -----------------------------------------------------------------

  shifts() {
    return this.db.tenant.shift.findMany({ orderBy: { name: 'asc' } });
  }

  async createShift(input: ShiftInput) {
    if (input.policyId) await this.db.tenant.attendancePolicy.findUniqueOrThrow({ where: { id: input.policyId } });
    const shift = await this.db.tenant.shift.create({
      data: { ...input, tenantId: requireTenantId(), policyId: input.policyId ?? null, code: input.code || null },
    });
    await this.audit.record({ action: 'shift.create', entityType: 'shift', entityId: shift.id, after: shift });
    return shift;
  }

  async updateShift(id: string, input: ShiftInput) {
    const before = await this.db.tenant.shift.findUnique({ where: { id } });
    if (!before) throw notFound('Shift');
    if (input.policyId) await this.db.tenant.attendancePolicy.findUniqueOrThrow({ where: { id: input.policyId } });
    const after = await this.db.tenant.shift.update({ where: { id }, data: { ...input, policyId: input.policyId ?? null, code: input.code || null } });
    await this.audit.record({ action: 'shift.update', entityType: 'shift', entityId: id, before, after });
    await this.recompute('ALL');
    return after;
  }

  /** Effective-dated: closes each employee's current assignment the day before. */
  async assignShift(input: ShiftAssignmentInput) {
    await this.db.tenant.shift.findUniqueOrThrow({ where: { id: input.shiftId } });
    const employees = await this.db.tenant.employee.count({ where: { id: { in: input.employeeIds } } });
    if (employees !== input.employeeIds.length) throw new AppError('VALIDATION_FAILED', 'Unknown employee in the list.');
    const from = toDbDate(input.effectiveFrom);
    const dayBefore = toDbDate(addDays(input.effectiveFrom, -1));
    const createdById = requireTenantUser().membershipId;
    const tenantId = requireTenantId();
    await this.db.tenant.$transaction(async (tx) => {
      await tx.shiftAssignment.deleteMany({ where: { employeeId: { in: input.employeeIds }, effectiveFrom: { gte: from } } });
      await tx.shiftAssignment.updateMany({
        where: { employeeId: { in: input.employeeIds }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: from } }] },
        data: { effectiveTo: dayBefore },
      });
      await tx.shiftAssignment.createMany({
        data: input.employeeIds.map((employeeId) => ({ tenantId, employeeId, shiftId: input.shiftId, effectiveFrom: from, createdById })),
      });
      await this.audit.record({ action: 'shift.assign', entityType: 'shift', entityId: input.shiftId, after: input }, tx);
    });
    await this.recompute([...input.employeeIds], input.effectiveFrom);
    return { assigned: input.employeeIds.length };
  }

  // ---- Weekly offs and holidays ---------------------------------------------

  patterns() {
    return this.db.tenant.weeklyOffPattern.findMany({ orderBy: { name: 'asc' } });
  }

  async createPattern(input: WeeklyOffPatternInput) {
    const pattern = await this.db.tenant.weeklyOffPattern.create({ data: { ...input, tenantId: requireTenantId() } });
    await this.audit.record({ action: 'weekly_off.create', entityType: 'weekly_off_pattern', entityId: pattern.id, after: pattern });
    return pattern;
  }

  async updatePattern(id: string, input: WeeklyOffPatternInput) {
    const before = await this.db.tenant.weeklyOffPattern.findUnique({ where: { id } });
    if (!before) throw notFound('Weekly-off pattern');
    const after = await this.db.tenant.weeklyOffPattern.update({ where: { id }, data: input });
    await this.audit.record({ action: 'weekly_off.update', entityType: 'weekly_off_pattern', entityId: id, before, after });
    await this.recompute('ALL');
    return after;
  }

  async calendars() {
    const calendars = await this.db.tenant.holidayCalendar.findMany({ orderBy: { name: 'asc' }, include: { _count: { select: { holidays: true } } } });
    return calendars;
  }

  async createCalendar(input: HolidayCalendarInput) {
    const calendar = await this.db.tenant.$transaction(async (tx) => {
      if (input.isDefault) await tx.holidayCalendar.updateMany({ where: {}, data: { isDefault: false } });
      return tx.holidayCalendar.create({ data: { ...input, tenantId: requireTenantId() } });
    });
    await this.audit.record({ action: 'calendar.create', entityType: 'holiday_calendar', entityId: calendar.id, after: calendar });
    return calendar;
  }

  async holidays(calendarId: string, year: number) {
    const rows = await this.db.tenant.holiday.findMany({
      where: { calendarId, holidayDate: { gte: toDbDate(`${year}-01-01`), lte: toDbDate(`${year}-12-31`) } },
      orderBy: { holidayDate: 'asc' },
    });
    return rows.map((h) => ({ ...h, holidayDate: dateOnly(h.holidayDate) }));
  }

  async addHoliday(calendarId: string, input: HolidayInput) {
    await this.db.tenant.holidayCalendar.findUniqueOrThrow({ where: { id: calendarId } });
    const holiday = await this.db.tenant.holiday.create({
      data: {
        tenantId: requireTenantId(),
        calendarId,
        holidayDate: toDbDate(input.holidayDate),
        name: input.name,
        kind: input.kind,
        isPaid: input.isPaid,
      },
    });
    await this.audit.record({ action: 'holiday.create', entityType: 'holiday', entityId: holiday.id, after: input });
    await this.recompute('ALL', input.holidayDate, input.holidayDate);
    return { ...holiday, holidayDate: input.holidayDate };
  }

  async removeHoliday(holidayId: string) {
    const holiday = await this.db.tenant.holiday.findUnique({ where: { id: holidayId } });
    if (!holiday) throw notFound('Holiday');
    await this.db.tenant.holiday.delete({ where: { id: holidayId } });
    await this.audit.record({ action: 'holiday.delete', entityType: 'holiday', entityId: holidayId, before: holiday });
    const date = dateOnly(holiday.holidayDate) as string;
    await this.recompute('ALL', date, date);
  }

  // ---- Per-employee overrides -------------------------------------------------

  async overrides(from: string, to: string) {
    const rows = await this.db.tenant.employeeDayOverride.findMany({
      where: { revokedAt: null, overrideDate: { gte: toDbDate(from), lte: toDbDate(to) } },
      orderBy: { overrideDate: 'asc' },
    });
    const employees = await this.db.tenant.employee.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.employeeId))] } },
      select: { id: true, fullName: true, employeeCode: true },
    });
    const byId = new Map(employees.map((e) => [e.id, e]));
    return rows.map((r) => ({
      id: r.id,
      employee: byId.get(r.employeeId) ?? null,
      date: dateOnly(r.overrideDate),
      allowPunch: r.allowPunch,
      reason: r.reason,
    }));
  }

  async grantOverrides(input: DayOverrideInput) {
    const count = await this.db.tenant.employee.count({ where: { id: { in: input.employeeIds } } });
    if (count !== input.employeeIds.length) throw new AppError('VALIDATION_FAILED', 'Unknown employee in the list.');
    const createdById = requireTenantUser().membershipId;
    let created = 0;
    await this.db.tenant.$transaction(async (tx) => {
      for (const employeeId of input.employeeIds) {
        for (const date of input.dates) {
          const liveKey = `${employeeId}:${date}`;
          await tx.employeeDayOverride.updateMany({ where: { liveKey }, data: { liveKey: null, revokedAt: new Date(), revokedById: createdById } });
          await tx.employeeDayOverride.create({
            data: {
              tenantId: requireTenantId(),
              employeeId,
              overrideDate: toDbDate(date),
              allowPunch: input.allowPunch,
              reason: input.reason,
              createdById,
              liveKey,
            },
          });
          created += 1;
        }
      }
      await this.audit.record({ action: 'override.grant', entityType: 'day_override', after: input, reason: input.reason }, tx);
    });
    const sorted = [...input.dates].sort();
    await this.recompute([...input.employeeIds], sorted[0], sorted[sorted.length - 1]);
    return { created };
  }

  async revokeOverride(id: string, reason: string) {
    const row = await this.db.tenant.employeeDayOverride.findUnique({ where: { id } });
    if (!row || row.revokedAt) throw notFound('Override');
    await this.db.tenant.employeeDayOverride.update({
      where: { id },
      data: { revokedAt: new Date(), revokedById: requireTenantUser().membershipId, liveKey: null },
    });
    await this.audit.record({ action: 'override.revoke', entityType: 'day_override', entityId: id, reason });
    const date = dateOnly(row.overrideDate) as string;
    await this.recompute([row.employeeId], date, date);
  }

  /** Flags existing attendance days (never beyond today); each is recomputed on its next read. */
  private async recompute(employeeIds: string[] | 'ALL', from?: string, to?: string): Promise<void> {
    const tenantId = requireTenantId();
    const tz = (await this.db.platform.tenant.findUniqueOrThrow({ where: { id: tenantId } })).timezone;
    const today = localDateOf(new Date(), tz);
    const start = from ?? addDays(today, -31);
    const end = minDate(to ?? today, today);
    if (start > end) return;
    await this.days.markStale(employeeIds, start, end);
  }
}
