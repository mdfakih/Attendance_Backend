import { Injectable } from '@nestjs/common';
import type { ExportRequestInput } from '@attendance/contracts';
import { DbService } from '../../core/database/db.service.js';
import { AppError } from '../../core/http/app-error.js';
import { buildXlsx, type SheetColumn, XLSX_MIME } from '../../common/xlsx.js';
import { PDF_MIME, tablePdf } from './pdf.js';
import { AttendanceQueryService } from '../attendance/attendance-query.service.js';
import { PayService } from '../pay/pay.service.js';
import { LeaveService } from '../leave/leave.service.js';
import { employeeScopeWhere } from '../../core/auth/scope.js';
import { dateOnly, iso, money } from '../../common/serialize.js';
import { toDbDate } from '../../engines/time/dates.js';

export interface GeneratedFile {
  readonly fileName: string;
  readonly mime: string;
  readonly buffer: Buffer;
}

const hours = (minutes: number): string => (minutes / 60).toFixed(2);

@Injectable()
export class ExportGenerators {
  constructor(
    private readonly db: DbService,
    private readonly attendance: AttendanceQueryService,
    private readonly pay: PayService,
    private readonly leave: LeaveService,
  ) {}

  async generate(params: ExportRequestInput): Promise<GeneratedFile> {
    switch (params.type) {
      case 'ATTENDANCE_REGISTER':
        return this.attendanceRegister(params);
      case 'ATTENDANCE_DAILY':
        return this.attendanceDaily(params);
      case 'PUNCH_LOG':
        return this.punchLog(params);
      case 'SALARY_REGISTER':
        return this.salaryRegister(params);
      case 'LEAVE_REGISTER':
        return this.leaveRegister(params);
      case 'EMPLOYEE_MASTER':
        return this.employeeMaster(params);
      default:
        throw new AppError('VALIDATION_FAILED', 'Unknown export type.');
    }
  }

  private async emit(name: string, format: 'XLSX' | 'PDF', columns: SheetColumn[], rows: Array<Record<string, unknown>>, title: string, subtitle: string): Promise<GeneratedFile> {
    if (format === 'XLSX') {
      return { fileName: `${name}.xlsx`, mime: XLSX_MIME, buffer: await buildXlsx([{ name: title.slice(0, 30), columns, rows }]) };
    }
    const buffer = await tablePdf({
      title,
      subtitle,
      headers: columns.map((c) => c.header),
      rows: rows.map((r) => columns.map((c) => (r[c.key] === null || r[c.key] === undefined ? '' : String(r[c.key])))),
      landscape: columns.length > 7,
    });
    return { fileName: `${name}.pdf`, mime: PDF_MIME, buffer };
  }

  private async attendanceRegister(p: ExportRequestInput): Promise<GeneratedFile> {
    const month = p.month as string;
    const { dates, items } = await this.attendance.register({ month, page: 1, pageSize: 100_000, branchId: p.branchId, departmentId: p.departmentId });
    const columns: SheetColumn[] = [
      { header: 'Employee code', key: 'code', width: 14 },
      { header: 'Name', key: 'name', width: 26 },
      ...dates.map((d) => ({ header: d.slice(8), key: d, width: 4 })),
      { header: 'Present', key: 'present' },
      { header: 'Half days', key: 'halfDay' },
      { header: 'Absent', key: 'absent' },
      { header: 'Leave', key: 'leave' },
      { header: 'Weekly off', key: 'weeklyOff' },
      { header: 'Holidays', key: 'holiday' },
      { header: 'Late', key: 'late' },
      { header: 'LOP days', key: 'lop' },
      { header: 'Hours', key: 'hours' },
      { header: 'OT hours', key: 'ot' },
    ];
    const rows = items.map((i) => ({
      code: i.employee.employeeCode ?? '',
      name: i.employee.fullName,
      ...i.days,
      present: i.totals.present,
      halfDay: i.totals.halfDay,
      absent: i.totals.absent,
      leave: i.totals.leave,
      weeklyOff: i.totals.weeklyOff,
      holiday: i.totals.holiday,
      late: i.totals.late,
      lop: i.totals.lopDays,
      hours: hours(i.totals.workedMinutes),
      ot: hours(i.totals.otMinutes),
    }));
    if (p.format === 'PDF') {
      // The day grid does not fit on paper; the PDF carries totals only.
      const summaryColumns = columns.filter((c) => !dates.includes(c.key));
      return this.emit(`attendance-register-${month}`, 'PDF', summaryColumns, rows, 'Attendance register', `Month ${month}`);
    }
    return this.emit(`attendance-register-${month}`, 'XLSX', columns, rows, 'Attendance register', `Month ${month}`);
  }

  private async attendanceDaily(p: ExportRequestInput): Promise<GeneratedFile> {
    const date = p.date as string;
    const { items } = await this.attendance.daily({ date, page: 1, pageSize: 100_000, branchId: p.branchId, departmentId: p.departmentId });
    const columns: SheetColumn[] = [
      { header: 'Employee code', key: 'code', width: 14 },
      { header: 'Name', key: 'name', width: 26 },
      { header: 'Branch', key: 'branch', width: 18 },
      { header: 'Status', key: 'status', width: 12 },
      { header: 'First punch', key: 'first', width: 20 },
      { header: 'Last punch', key: 'last', width: 20 },
      { header: 'Hours', key: 'hours' },
      { header: 'Late (min)', key: 'late' },
      { header: 'Flags', key: 'flags', width: 24 },
    ];
    const rows = items.map((i) => ({
      code: i.employee.employeeCode ?? '',
      name: i.employee.fullName,
      branch: i.employee.branch?.name ?? '',
      status: i.status,
      first: i.firstPunchAt ?? '',
      last: i.lastPunchAt ?? '',
      hours: hours(i.workedMinutes),
      late: i.lateMinutes,
      flags: i.flags.join(', '),
    }));
    return this.emit(`attendance-${date}`, p.format, columns, rows, 'Daily attendance', `Date ${date}`);
  }

  private async punchLog(p: ExportRequestInput): Promise<GeneratedFile> {
    const punches = await this.db.tenant.punch.findMany({
      where: {
        attendanceDate: { gte: toDbDate(p.from as string), lte: toDbDate(p.to as string) },
        employee: { ...employeeScopeWhere(), ...(p.branchId ? { branchId: p.branchId } : {}), ...(p.departmentId ? { departmentId: p.departmentId } : {}) },
      },
      include: { employee: { select: { fullName: true, employeeCode: true } } },
      orderBy: { serverTime: 'asc' },
      take: 200_000,
    });
    const sites = new Map((await this.db.tenant.site.findMany({ select: { id: true, name: true } })).map((s) => [s.id, s.name]));
    const columns: SheetColumn[] = [
      { header: 'Date', key: 'date', width: 12 },
      { header: 'Employee code', key: 'code', width: 14 },
      { header: 'Name', key: 'name', width: 26 },
      { header: 'Direction', key: 'direction' },
      { header: 'Time (UTC)', key: 'time', width: 22 },
      { header: 'Site', key: 'site', width: 20 },
      { header: 'Distance (m)', key: 'distance' },
      { header: 'Accuracy (m)', key: 'accuracy' },
      { header: 'Source', key: 'source' },
      { header: 'Flags', key: 'flags', width: 24 },
    ];
    const rows = punches.map((x) => ({
      date: dateOnly(x.attendanceDate),
      code: x.employee.employeeCode ?? '',
      name: x.employee.fullName,
      direction: x.direction,
      time: iso(x.serverTime),
      site: x.siteId ? (sites.get(x.siteId) ?? '') : '',
      distance: x.distanceM ?? '',
      accuracy: x.accuracyM ?? '',
      source: x.voidedAt ? 'VOIDED' : x.source,
      flags: x.flags.join(', '),
    }));
    return this.emit(`punch-log-${p.from}-${p.to}`, p.format, columns, rows, 'Punch log', `${p.from} to ${p.to}`);
  }

  private async salaryRegister(p: ExportRequestInput): Promise<GeneratedFile> {
    const month = p.month as string;
    const { items, status } = await this.pay.register({ month, page: 1, pageSize: 100_000, branchId: p.branchId, departmentId: p.departmentId });
    const columns: SheetColumn[] = [
      { header: 'Employee code', key: 'code', width: 14 },
      { header: 'Name', key: 'name', width: 26 },
      { header: 'Branch', key: 'branch', width: 18 },
      { header: 'Basis', key: 'basis' },
      { header: 'Rate (₹)', key: 'rate', width: 12 },
      { header: 'Payable days', key: 'payable' },
      { header: 'LOP days', key: 'lop' },
      { header: 'Hours', key: 'hours' },
      { header: 'OT hours', key: 'ot' },
      { header: 'Base (₹)', key: 'base', width: 12 },
      { header: 'OT pay (₹)', key: 'otPay', width: 12 },
      { header: 'Additions (₹)', key: 'add', width: 12 },
      { header: 'Deductions (₹)', key: 'ded', width: 12 },
      { header: 'Net earned (₹)', key: 'net', width: 14 },
      { header: 'Flags', key: 'flags', width: 20 },
    ];
    const rows = items.map((i) => ({
      code: i.employee.employeeCode ?? '',
      name: i.employee.fullName,
      branch: i.employee.branch ?? '',
      basis: i.basis ?? '',
      rate: i.rate ?? '',
      payable: i.payableDays,
      lop: i.lopDays,
      hours: hours(i.workedMinutes),
      ot: hours(i.otMinutes),
      base: i.baseEarned,
      otPay: i.otEarned,
      add: i.additions,
      ded: i.deductions,
      net: i.netEarned,
      flags: i.flags.join(', '),
    }));
    return this.emit(`salary-register-${month}`, p.format, columns, rows, 'Salary register (earned, before statutory deductions)', `Month ${month} · ${status}`);
  }

  private async leaveRegister(p: ExportRequestInput): Promise<GeneratedFile> {
    const month = p.month as string;
    const { items } = await this.leave.list({ page: 1, pageSize: 100_000, from: `${month}-01`, to: `${month}-31` });
    const columns: SheetColumn[] = [
      { header: 'Employee code', key: 'code', width: 14 },
      { header: 'Name', key: 'name', width: 26 },
      { header: 'Leave type', key: 'type', width: 16 },
      { header: 'From', key: 'from', width: 12 },
      { header: 'To', key: 'to', width: 12 },
      { header: 'Days', key: 'days' },
      { header: 'Status', key: 'status' },
      { header: 'Reason', key: 'reason', width: 30 },
    ];
    const rows = items.map((r) => ({
      code: r.employee?.employeeCode ?? '',
      name: r.employee?.fullName ?? '',
      type: r.leaveType?.name ?? '',
      from: r.fromDate,
      to: r.toDate,
      days: r.days,
      status: r.status,
      reason: r.reason,
    }));
    return this.emit(`leave-register-${month}`, p.format, columns, rows, 'Leave register', `Month ${month}`);
  }

  private async employeeMaster(p: ExportRequestInput): Promise<GeneratedFile> {
    const employees = await this.db.tenant.employee.findMany({
      where: { ...employeeScopeWhere(), status: { in: ['ACTIVE', 'INVITED'] }, ...(p.branchId ? { branchId: p.branchId } : {}) },
      include: { branch: { select: { name: true } }, department: { select: { name: true } }, sites: { include: { site: { select: { name: true } } } }, salaryAssignments: { where: { effectiveTo: null }, take: 1 } },
      orderBy: { fullName: 'asc' },
    });
    const columns: SheetColumn[] = [
      { header: 'Employee code', key: 'code', width: 14 },
      { header: 'Name', key: 'name', width: 26 },
      { header: 'Mobile', key: 'phone', width: 16 },
      { header: 'Email', key: 'email', width: 24 },
      { header: 'Designation', key: 'designation', width: 18 },
      { header: 'Branch', key: 'branch', width: 18 },
      { header: 'Department', key: 'department', width: 18 },
      { header: 'Sites', key: 'sites', width: 24 },
      { header: 'Date of joining', key: 'doj', width: 14 },
      { header: 'Status', key: 'status' },
      { header: 'Salary basis', key: 'basis' },
      { header: 'Salary (₹)', key: 'salary', width: 12 },
    ];
    const rows = employees.map((e) => ({
      code: e.employeeCode ?? '',
      name: e.fullName,
      phone: e.phoneE164,
      email: e.email ?? '',
      designation: e.designation ?? '',
      branch: e.branch.name,
      department: e.department?.name ?? '',
      sites: e.sites.map((s) => s.site.name).join(', '),
      doj: dateOnly(e.dateOfJoining),
      status: e.status,
      basis: e.salaryAssignments[0]?.salaryBasis ?? '',
      salary: money(e.salaryAssignments[0]?.amount) ?? '',
    }));
    return this.emit('employees', p.format, columns, rows, 'Employee master', `${rows.length} employees`);
  }
}
