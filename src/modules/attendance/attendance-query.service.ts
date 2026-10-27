import { Injectable } from '@nestjs/common';
import type { AttendanceDailyQuery, AttendanceRegisterQuery } from '@attendance/contracts';
import { AuditService } from '../../core/audit/audit.service.js';
import { employeeScopeWhere, isInScope } from '../../core/auth/scope.js';
import { requireTenantId } from '../../core/context/request-context.js';
import { DbService } from '../../core/database/db.service.js';
import { notFound } from '../../core/http/app-error.js';
import { StorageService } from '../../core/storage/storage.service.js';
import { dateOnly, iso, num } from '../../common/serialize.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { eachDate, localDateOf, monthRange, toDbDate } from '../../engines/time/dates.js';

const SHORT: Readonly<Record<string, string>> = {
  PRESENT: 'P',
  HALF_DAY: 'HD',
  ABSENT: 'A',
  LEAVE: 'L',
  HALF_LEAVE: 'HL',
  HOLIDAY: 'H',
  WEEKLY_OFF: 'WO',
  IN_PROGRESS: '…',
  NOT_STARTED: '',
  MISSING_OUT: 'MO',
};

@Injectable()
export class AttendanceQueryService {
  constructor(
    private readonly db: DbService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
  ) {}

  async today(): Promise<string> {
    const tenant = await this.db.platform.tenant.findUniqueOrThrow({ where: { id: requireTenantId() }, select: { timezone: true } });
    return localDateOf(new Date(), tenant.timezone);
  }

  async daily(query: AttendanceDailyQuery) {
    const date = toDbDate(query.date);
    const employeeWhere: Prisma.EmployeeWhereInput = {
      ...employeeScopeWhere(),
      status: { in: ['ACTIVE', 'INVITED'] },
      dateOfJoining: { lte: date },
      ...(query.branchId ? { branchId: query.branchId } : {}),
      ...(query.departmentId ? { departmentId: query.departmentId } : {}),
      ...(query.siteId ? { sites: { some: { siteId: query.siteId } } } : {}),
      ...(query.q
        ? { OR: [{ fullName: { contains: query.q, mode: 'insensitive' } }, { employeeCode: { contains: query.q, mode: 'insensitive' } }] }
        : {}),
      ...(query.status === 'NOT_STARTED'
        ? { attendanceDays: { none: { attendanceDate: date, punchCount: { gt: 0 } } } }
        : query.status
          ? { attendanceDays: { some: { attendanceDate: date, finalStatus: query.status } } }
          : {}),
      ...(query.late ? { attendanceDays: { some: { attendanceDate: date, isLate: true } } } : {}),
    };
    const [employees, total] = await Promise.all([
      this.db.tenant.employee.findMany({
        where: employeeWhere,
        include: {
          branch: { select: { id: true, name: true } },
          attendanceDays: { where: { attendanceDate: date } },
        },
        orderBy: { fullName: 'asc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.db.tenant.employee.count({ where: employeeWhere }),
    ]);
    const items = employees.map((e) => {
      const day = e.attendanceDays[0];
      return {
        employee: { id: e.id, fullName: e.fullName, employeeCode: e.employeeCode, branch: e.branch },
        status: day?.finalStatus ?? 'NOT_STARTED',
        statusSource: day?.statusSource ?? 'COMPUTED',
        dayType: day?.dayType ?? null,
        punchCount: day?.punchCount ?? 0,
        firstPunchAt: iso(day?.firstPunchAt),
        lastPunchAt: iso(day?.lastPunchAt),
        workedMinutes: day?.workedMinutes ?? 0,
        isLate: day?.isLate ?? false,
        lateMinutes: day?.lateMinutes ?? 0,
        isMissingOut: day?.isMissingOut ?? false,
        otMinutes: day?.otMinutes ?? 0,
        otState: day?.otState ?? 'NOT_APPLICABLE',
        flags: day?.flags ?? [],
      };
    });
    return { items, total };
  }

  async register(query: AttendanceRegisterQuery) {
    const { start, end } = monthRange(query.month);
    const where: Prisma.EmployeeWhereInput = {
      ...employeeScopeWhere(),
      dateOfJoining: { lte: toDbDate(end) },
      OR: [{ status: { in: ['ACTIVE', 'INVITED'] } }, { exitDate: { gte: toDbDate(start) } }],
      ...(query.branchId ? { branchId: query.branchId } : {}),
      ...(query.departmentId ? { departmentId: query.departmentId } : {}),
      ...(query.q ? { fullName: { contains: query.q, mode: 'insensitive' } } : {}),
    };
    const [employees, total] = await Promise.all([
      this.db.tenant.employee.findMany({
        where,
        include: { attendanceDays: { where: { attendanceDate: { gte: toDbDate(start), lte: toDbDate(end) } } } },
        orderBy: { fullName: 'asc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.db.tenant.employee.count({ where }),
    ]);
    const dates = eachDate(start, end);
    const items = employees.map((e) => {
      const byDate = new Map(e.attendanceDays.map((d) => [dateOnly(d.attendanceDate) as string, d]));
      const days = Object.fromEntries(dates.map((d) => [d, SHORT[byDate.get(d)?.finalStatus ?? 'NOT_STARTED'] ?? '']));
      const rows = e.attendanceDays;
      const count = (status: string) => rows.filter((d) => d.finalStatus === status).length;
      return {
        employee: { id: e.id, fullName: e.fullName, employeeCode: e.employeeCode },
        days,
        totals: {
          present: count('PRESENT'),
          halfDay: count('HALF_DAY'),
          absent: count('ABSENT'),
          leave: count('LEAVE') + count('HALF_LEAVE') * 0.5,
          weeklyOff: count('WEEKLY_OFF'),
          holiday: count('HOLIDAY'),
          late: rows.filter((d) => d.isLate).length,
          lopDays: rows.reduce((acc, d) => acc + Number(d.lopFraction), 0),
          workedMinutes: rows.reduce((acc, d) => acc + d.workedMinutes, 0),
          otMinutes: rows.reduce((acc, d) => acc + d.otApprovedMinutes, 0),
        },
      };
    });
    return { dates, items, total };
  }

  async employeeMonth(employeeId: string, month: string) {
    const employee = await this.db.tenant.employee.findUnique({ where: { id: employeeId } });
    if (!employee || !isInScope(employee)) throw notFound('Employee');
    return this.monthView(employeeId, month);
  }

  /** Shared by the employer calendar and the employee app. */
  async monthView(employeeId: string, month: string) {
    const { start, end } = monthRange(month);
    const days = await this.db.tenant.attendanceDay.findMany({
      where: { employeeId, attendanceDate: { gte: toDbDate(start), lte: toDbDate(end) } },
      orderBy: { attendanceDate: 'asc' },
    });
    const holidays = await this.db.tenant.holiday.findMany({
      where: { id: { in: days.map((d) => d.holidayId).filter((v): v is string => !!v) } },
      select: { id: true, name: true },
    });
    const holidayName = new Map(holidays.map((h) => [h.id, h.name]));
    const items = days.map((d) => ({
      date: dateOnly(d.attendanceDate),
      status: d.finalStatus,
      statusSource: d.statusSource,
      dayType: d.dayType,
      holidayName: d.holidayId ? (holidayName.get(d.holidayId) ?? null) : null,
      punchCount: d.punchCount,
      firstPunchAt: iso(d.firstPunchAt),
      lastPunchAt: iso(d.lastPunchAt),
      workedMinutes: d.workedMinutes,
      isLate: d.isLate,
      lateMinutes: d.lateMinutes,
      isMissingOut: d.isMissingOut,
      otMinutes: d.otMinutes,
      otApprovedMinutes: d.otApprovedMinutes,
      leaveFraction: num(d.leaveFraction),
      flags: d.flags,
    }));
    const totals = {
      workedMinutes: days.reduce((acc, d) => acc + d.workedMinutes, 0),
      present: days.filter((d) => d.finalStatus === 'PRESENT').length,
      halfDay: days.filter((d) => d.finalStatus === 'HALF_DAY').length,
      absent: days.filter((d) => d.finalStatus === 'ABSENT').length,
      leave: days.reduce((acc, d) => acc + Number(d.leaveFraction), 0),
      late: days.filter((d) => d.isLate).length,
    };
    return { month, days: items, totals };
  }

  async dayDetail(employeeId: string, date: string, withSelfies = true) {
    const employee = await this.db.tenant.employee.findUnique({ where: { id: employeeId }, select: { id: true, fullName: true, branchId: true, departmentId: true } });
    if (!employee || !isInScope(employee)) throw notFound('Employee');
    const [day, punches, marks] = await Promise.all([
      this.db.tenant.attendanceDay.findUnique({ where: { employeeId_attendanceDate: { employeeId, attendanceDate: toDbDate(date) } } }),
      this.db.tenant.punch.findMany({ where: { employeeId, attendanceDate: toDbDate(date) }, orderBy: { serverTime: 'asc' } }),
      this.db.tenant.attendanceManualMark.findMany({ where: { employeeId, attendanceDate: toDbDate(date) }, orderBy: { createdAt: 'desc' } }),
    ]);
    const sites = await this.db.tenant.site.findMany({
      where: { id: { in: punches.map((p) => p.siteId).filter((v): v is string => !!v) } },
      select: { id: true, name: true },
    });
    const siteName = new Map(sites.map((s) => [s.id, s.name]));
    if (withSelfies && punches.some((p) => p.selfieKey)) {
      await this.audit.record({ action: 'selfie.view', entityType: 'employee', entityId: employeeId, after: { date } });
    }
    const punchDtos = await Promise.all(
      punches.map(async (p) => ({
        id: p.id,
        serverTime: iso(p.serverTime),
        direction: p.direction,
        sequenceNo: p.sequenceNo,
        source: p.source,
        lat: p.lat,
        lng: p.lng,
        accuracyM: p.accuracyM,
        site: p.siteId ? { id: p.siteId, name: siteName.get(p.siteId) ?? '' } : null,
        distanceM: p.distanceM,
        flags: p.flags,
        voided: !!p.voidedAt,
        reason: p.reason,
        selfieUrl: withSelfies && p.selfieKey && !p.selfiePurgedAt ? await this.storage.presignGet(p.selfieKey, 300) : null,
        thumbUrl: withSelfies && (p.thumbKey ?? p.selfieKey) && !p.selfiePurgedAt ? await this.storage.presignGet((p.thumbKey ?? p.selfieKey) as string, 300) : null,
      })),
    );
    return {
      employee: { id: employee.id, fullName: employee.fullName },
      date,
      day: day && {
        status: day.finalStatus,
        computedStatus: day.computedStatus,
        statusSource: day.statusSource,
        dayType: day.dayType,
        workedMinutes: day.workedMinutes,
        isLate: day.isLate,
        lateMinutes: day.lateMinutes,
        earlyLeaveMinutes: day.earlyLeaveMinutes,
        isMissingOut: day.isMissingOut,
        otMinutes: day.otMinutes,
        otState: day.otState,
        otApprovedMinutes: day.otApprovedMinutes,
        expectedStartAt: iso(day.expectedStartAt),
        expectedEndAt: iso(day.expectedEndAt),
        isFinalized: day.isFinalized,
        flags: day.flags,
        periodLocked: day.periodLocked,
      },
      punches: punchDtos,
      manualMarks: marks.map((m) => ({
        id: m.id,
        action: m.action,
        status: m.status,
        reason: m.reason,
        previousStatus: m.previousFinalStatus,
        markedById: m.markedById,
        createdAt: iso(m.createdAt),
      })),
    };
  }

  async rejections(date: string) {
    const tenant = await this.db.platform.tenant.findUniqueOrThrow({ where: { id: requireTenantId() }, select: { timezone: true } });
    const from = new Date(`${date}T00:00:00Z`);
    const rows = await this.db.tenant.punchRejection.findMany({
      where: { attemptedAt: { gte: new Date(from.getTime() - 86_400_000), lte: new Date(from.getTime() + 2 * 86_400_000) } },
      orderBy: { attemptedAt: 'desc' },
      take: 500,
    });
    const local = rows.filter((r) => localDateOf(r.attemptedAt, tenant.timezone) === date);
    const employees = await this.db.tenant.employee.findMany({
      where: { id: { in: [...new Set(local.map((r) => r.employeeId))] }, ...employeeScopeWhere() },
      select: { id: true, fullName: true, employeeCode: true },
    });
    const byId = new Map(employees.map((e) => [e.id, e]));
    return local
      .filter((r) => byId.has(r.employeeId))
      .map((r) => ({
        id: r.id,
        employee: byId.get(r.employeeId),
        attemptedAt: iso(r.attemptedAt),
        stage: r.stage,
        reason: r.reasonCode,
        distanceM: r.distanceM,
        accuracyM: r.accuracyM,
      }));
  }
}
