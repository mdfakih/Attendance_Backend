import { Injectable } from '@nestjs/common';
import type { DashboardQuery } from '@attendance/contracts';
import { employeeScopeWhere } from '../../core/auth/scope.js';
import { requireTenantId } from '../../core/context/request-context.js';
import { DbService } from '../../core/database/db.service.js';
import { CacheService } from '../../core/redis/cache.service.js';
import { StorageService } from '../../core/storage/storage.service.js';
import { iso } from '../../common/serialize.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { localDateOf, toDbDate } from '../../engines/time/dates.js';
import { AttendanceSettleService } from '../attendance/attendance-settle.service.js';
import { RegularizationService } from '../attendance/regularization.service.js';
import { HousekeepingService } from '../housekeeping/housekeeping.service.js';

@Injectable()
export class DashboardService {
  constructor(
    private readonly db: DbService,
    private readonly cache: CacheService,
    private readonly storage: StorageService,
    private readonly settle: AttendanceSettleService,
    private readonly regularizations: RegularizationService,
    private readonly housekeeping: HousekeepingService,
  ) {}

  async summary(query: DashboardQuery) {
    const tenantId = requireTenantId();
    this.housekeeping.ensureToday();
    const date = query.date ?? (await this.today(tenantId));
    const employeeWhere = this.employeeWhere(query, date);
    // Counts come from stored rows: absent employees and closed days must be written first.
    await this.settle.settle(date, date, employeeWhere);
    const [employees, days, pendingDevices, pendingLeave, pendingRegularizations] = await Promise.all([
      this.db.tenant.employee.count({ where: employeeWhere }),
      this.db.tenant.attendanceDay.groupBy({
        by: ['finalStatus'],
        where: { attendanceDate: toDbDate(date), employee: employeeWhere },
        _count: { _all: true },
      }),
      this.db.tenant.deviceBinding.count({ where: { status: 'PENDING', employee: employeeScopeWhere() } }),
      this.db.tenant.leaveRequest.count({ where: { status: 'PENDING', employee: employeeScopeWhere() } }),
      this.regularizations.pendingCount(),
    ]);
    const [late, missingOut, withPunches] = await Promise.all([
      this.db.tenant.attendanceDay.count({ where: { attendanceDate: toDbDate(date), isLate: true, employee: employeeWhere } }),
      this.db.tenant.attendanceDay.count({ where: { attendanceDate: toDbDate(date), isMissingOut: true, employee: employeeWhere } }),
      this.db.tenant.attendanceDay.count({ where: { attendanceDate: toDbDate(date), punchCount: { gt: 0 }, employee: employeeWhere } }),
    ]);
    const count = (status: string) => days.find((d) => d.finalStatus === status)?._count._all ?? 0;
    const offDay = count('HOLIDAY') + count('WEEKLY_OFF');
    return {
      date,
      employees,
      present: count('PRESENT') + count('IN_PROGRESS'),
      halfDay: count('HALF_DAY') + count('HALF_LEAVE'),
      absent: count('ABSENT'),
      onLeave: count('LEAVE'),
      offDay,
      late,
      missingOut,
      yetToPunch: Math.max(employees - withPunches - count('LEAVE') - offDay, 0),
      pending: { devices: pendingDevices, leave: pendingLeave, regularizations: pendingRegularizations },
      asOf: new Date().toISOString(),
    };
  }

  async live(query: DashboardQuery) {
    const tenantId = requireTenantId();
    const date = query.date ?? (await this.today(tenantId));
    const punches = await this.db.tenant.punch.findMany({
      where: { attendanceDate: toDbDate(date), voidedAt: null, employee: this.employeeWhere(query, date) },
      orderBy: { serverTime: 'desc' },
      take: 50,
      include: { employee: { select: { id: true, fullName: true, employeeCode: true } } },
    });
    const sites = await this.siteNames(punches.map((p) => p.siteId));
    return Promise.all(
      punches.map(async (p) => ({
        id: p.id,
        employee: p.employee,
        direction: p.direction,
        at: iso(p.serverTime),
        site: p.siteId ? (sites.get(p.siteId) ?? null) : null,
        flags: p.flags,
        thumbUrl: p.thumbKey ?? p.selfieKey ? await this.storage.presignGet((p.thumbKey ?? p.selfieKey) as string, 300) : null,
      })),
    );
  }

  async map(query: DashboardQuery) {
    const tenantId = requireTenantId();
    const date = query.date ?? (await this.today(tenantId));
    const [punches, sites] = await Promise.all([
      this.db.tenant.punch.findMany({
        where: { attendanceDate: toDbDate(date), voidedAt: null, lat: { not: null }, employee: this.employeeWhere(query, date) },
        select: { id: true, lat: true, lng: true, direction: true, serverTime: true, siteId: true, employee: { select: { fullName: true } } },
        take: 5000,
      }),
      this.db.tenant.site.findMany({ where: { active: true, ...(query.siteId ? { id: query.siteId } : {}) }, select: { id: true, name: true, lat: true, lng: true, radiusM: true } }),
    ]);
    return {
      sites,
      points: punches.map((p) => ({ id: p.id, lat: p.lat, lng: p.lng, direction: p.direction, at: iso(p.serverTime), siteId: p.siteId, name: p.employee.fullName })),
    };
  }

  private employeeWhere(query: DashboardQuery, date: string): Prisma.EmployeeWhereInput {
    return {
      ...employeeScopeWhere(),
      status: { in: ['ACTIVE', 'INVITED'] },
      dateOfJoining: { lte: toDbDate(date) },
      ...(query.branchId ? { branchId: query.branchId } : {}),
      ...(query.departmentId ? { departmentId: query.departmentId } : {}),
      ...(query.siteId ? { sites: { some: { siteId: query.siteId } } } : {}),
    };
  }

  private today(tenantId: string): Promise<string> {
    return this.cache.remember(`tz:${tenantId}`, 300, async () => {
      const t = await this.db.platform.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { timezone: true } });
      return t.timezone;
    }).then((tz) => localDateOf(new Date(), tz));
  }

  private async siteNames(ids: Array<string | null>): Promise<Map<string, string>> {
    const rows = await this.db.tenant.site.findMany({ where: { id: { in: ids.filter((v): v is string => !!v) } }, select: { id: true, name: true } });
    return new Map(rows.map((s) => [s.id, s.name]));
  }
}
