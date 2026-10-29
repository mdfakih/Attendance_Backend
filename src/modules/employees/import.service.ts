import { Injectable } from '@nestjs/common';
import {
  EMPLOYEE_IMPORT_COLUMNS,
  type EmployeeCreateInput,
  employeeCreateSchema,
  type EmployeeImportColumnKey,
  normalizeIndianPhone,
  SALARY_BASES,
} from '@attendance/contracts';
import { AuditService } from '../../core/audit/audit.service.js';
import { requireTenantId, requireTenantUser } from '../../core/context/request-context.js';
import { DbService } from '../../core/database/db.service.js';
import { AppError, notFound } from '../../core/http/app-error.js';
import { buildXlsx, readXlsx } from '../../common/xlsx.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { EmployeesService } from './employees.service.js';

const MAX_ROWS = 5000;

interface Lookups {
  readonly branches: ReadonlyMap<string, string>;
  readonly departments: ReadonlyMap<string, string>;
  readonly sites: ReadonlyMap<string, string>;
  readonly shifts: ReadonlyMap<string, string>;
}

interface RowOutcome {
  readonly rowNo: number;
  readonly raw: Record<string, string>;
  readonly input: EmployeeCreateInput | null;
  readonly errors: string[];
}

const key = (s: string) => s.trim().toLowerCase();

@Injectable()
export class ImportService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly employees: EmployeesService,
  ) {}

  async template(): Promise<Buffer> {
    const [branches, departments, sites, shifts] = await Promise.all([
      this.db.tenant.branch.findMany({ where: { active: true }, select: { name: true } }),
      this.db.tenant.department.findMany({ where: { active: true }, select: { name: true } }),
      this.db.tenant.site.findMany({ where: { active: true }, select: { name: true } }),
      this.db.tenant.shift.findMany({ where: { active: true }, select: { name: true } }),
    ]);
    const lists = Math.max(branches.length, departments.length, sites.length, shifts.length, SALARY_BASES.length, 1);
    const listRows = Array.from({ length: lists }, (_, i) => ({
      branch: branches[i]?.name ?? '',
      department: departments[i]?.name ?? '',
      site: sites[i]?.name ?? '',
      shift: shifts[i]?.name ?? '',
      basis: SALARY_BASES[i] ?? '',
    }));
    const range = (col: string, count: number) => `=Lists!$${col}$2:$${col}$${Math.max(count, 1) + 1}`;
    return buildXlsx([
      {
        name: 'Employees',
        columns: EMPLOYEE_IMPORT_COLUMNS.map((c) => ({ header: c.header, key: c.key, width: Math.max(18, c.header.length + 2) })),
        rows: [],
        listValidations: {
          branch: range('A', branches.length),
          department: range('B', departments.length),
          shift: range('D', shifts.length),
          salaryBasis: range('E', SALARY_BASES.length),
        },
      },
      {
        name: 'Lists',
        columns: [
          { header: 'Branches', key: 'branch', width: 28 },
          { header: 'Departments', key: 'department', width: 28 },
          { header: 'Sites', key: 'site', width: 28 },
          { header: 'Shifts', key: 'shift', width: 22 },
          { header: 'Salary basis', key: 'basis', width: 16 },
        ],
        rows: listRows,
      },
    ]);
  }

  async upload(fileName: string, buffer: Buffer) {
    const { headers, rows } = await readXlsx(buffer);
    const columnIndex = this.mapHeaders(headers);
    if (rows.length === 0) throw new AppError('IMPORT_INVALID', 'The file has no employee rows.');
    if (rows.length > MAX_ROWS) throw new AppError('IMPORT_INVALID', `Upload at most ${MAX_ROWS} rows at a time.`);
    const lookups = await this.lookups();
    const outcomes = rows.map((r) => this.parseRow(r.rowNo, r.values, columnIndex, lookups));
    const checked = await this.crossCheck(outcomes);
    const valid = checked.filter((o) => o.errors.length === 0).length;
    const created = await this.db.tenant.employeeImport.create({
      data: {
        tenantId: requireTenantId(),
        uploadedById: requireTenantUser().membershipId,
        fileName: fileName.slice(0, 200),
        status: 'VALIDATED',
        totalRows: checked.length,
        validRows: valid,
        errorRows: checked.length - valid,
        validatedAt: new Date(),
      },
    });
    await this.db.tenant.employeeImportRow.createMany({
      data: checked.map((o) => ({
        tenantId: created.tenantId,
        importId: created.id,
        rowNo: o.rowNo,
        raw: o.raw,
        normalized: (o.input ?? undefined) as Prisma.InputJsonValue | undefined,
        status: o.errors.length === 0 ? 'VALID' : 'ERROR',
        errors: o.errors,
      })),
    });
    return this.preview(created.id);
  }

  async preview(importId: string) {
    const imp = await this.db.tenant.employeeImport.findUnique({ where: { id: importId } });
    if (!imp) throw notFound('Import');
    const rows = await this.db.tenant.employeeImportRow.findMany({ where: { importId }, orderBy: { rowNo: 'asc' }, take: 1000 });
    return {
      id: imp.id,
      fileName: imp.fileName,
      status: imp.status,
      totalRows: imp.totalRows,
      validRows: imp.validRows,
      errorRows: imp.errorRows,
      committedRows: imp.committedRows,
      rows: rows.map((r) => ({ rowNo: r.rowNo, status: r.status, raw: r.raw, errors: r.errors, employeeId: r.employeeId })),
    };
  }

  async commit(importId: string) {
    const imp = await this.db.tenant.employeeImport.findUnique({ where: { id: importId } });
    if (!imp) throw notFound('Import');
    if (imp.status !== 'VALIDATED') throw new AppError('CONFLICT', 'This import was already committed or cancelled.');
    const tenant = await this.employees.tenantInfo();
    await this.employees.assertCapacity(tenant, imp.validRows);
    await this.db.tenant.employeeImport.update({ where: { id: importId }, data: { status: 'COMMITTING' } });
    const rows = await this.db.tenant.employeeImportRow.findMany({ where: { importId, status: 'VALID' }, orderBy: { rowNo: 'asc' } });
    const created: string[] = [];
    for (const row of rows) {
      const input = employeeCreateSchema.parse(row.normalized);
      try {
        const { id } = await this.db.tenant.$transaction((tx) => this.employees.createInTx(tx, tenant, input, 'IMPORT'));
        await this.db.tenant.employeeImportRow.update({ where: { id: row.id }, data: { status: 'COMMITTED', employeeId: id } });
        created.push(id);
      } catch (error: unknown) {
        const message = error instanceof AppError ? error.message : 'Could not create this employee.';
        await this.db.tenant.employeeImportRow.update({ where: { id: row.id }, data: { status: 'ERROR', errors: [message] } });
      }
    }
    const committed = created.length;
    await this.db.tenant.employeeImport.update({
      where: { id: importId },
      data: { status: 'COMMITTED', committedRows: committed, committedAt: new Date() },
    });
    await this.audit.record({ action: 'employee.import.commit', entityType: 'employee_import', entityId: importId, after: { committed } });
    this.employees.afterCreate(created);
    return this.preview(importId);
  }

  async cancel(importId: string) {
    await this.db.tenant.employeeImport.updateMany({ where: { id: importId, status: 'VALIDATED' }, data: { status: 'CANCELLED' } });
  }

  async committedEmployeeIds(importId: string): Promise<string[]> {
    const rows = await this.db.tenant.employeeImportRow.findMany({
      where: { importId, status: 'COMMITTED', employeeId: { not: null } },
      select: { employeeId: true },
    });
    return rows.map((r) => r.employeeId as string);
  }

  private mapHeaders(headers: readonly string[]): ReadonlyMap<EmployeeImportColumnKey, number> {
    const map = new Map<EmployeeImportColumnKey, number>();
    for (const column of EMPLOYEE_IMPORT_COLUMNS) {
      const index = headers.findIndex((h) => key(h) === key(column.header) || key(h).startsWith(key(column.header).split(' (')[0]));
      if (index >= 0) map.set(column.key, index);
    }
    const missing = EMPLOYEE_IMPORT_COLUMNS.filter((c) => c.required && !map.has(c.key)).map((c) => c.header);
    if (missing.length > 0) {
      throw new AppError('IMPORT_INVALID', `Missing columns: ${missing.join(', ')}. Download the template and try again.`);
    }
    return map;
  }

  private async lookups(): Promise<Lookups> {
    const [branches, departments, sites, shifts] = await Promise.all([
      this.db.tenant.branch.findMany({ select: { id: true, name: true } }),
      this.db.tenant.department.findMany({ select: { id: true, name: true } }),
      this.db.tenant.site.findMany({ select: { id: true, name: true } }),
      this.db.tenant.shift.findMany({ select: { id: true, name: true } }),
    ]);
    const index = (rows: Array<{ id: string; name: string }>) => new Map(rows.map((r) => [key(r.name), r.id]));
    return { branches: index(branches), departments: index(departments), sites: index(sites), shifts: index(shifts) };
  }

  private parseRow(rowNo: number, values: readonly string[], cols: ReadonlyMap<EmployeeImportColumnKey, number>, lookups: Lookups): RowOutcome {
    const get = (k: EmployeeImportColumnKey) => {
      const i = cols.get(k);
      return i === undefined ? '' : (values[i] ?? '').trim();
    };
    const raw = Object.fromEntries(EMPLOYEE_IMPORT_COLUMNS.map((c) => [c.key, get(c.key)]));
    const errors: string[] = [];
    const branchId = lookups.branches.get(key(get('branch')));
    if (!branchId) errors.push(`Unknown branch "${get('branch')}"`);
    const deptName = get('department');
    const departmentId = deptName ? lookups.departments.get(key(deptName)) : undefined;
    if (deptName && !departmentId) errors.push(`Unknown department "${deptName}"`);
    const siteNames = get('sites').split(',').map((s) => s.trim()).filter(Boolean);
    const siteIds = siteNames.map((s) => lookups.sites.get(key(s)));
    siteNames.forEach((s, i) => {
      if (!siteIds[i]) errors.push(`Unknown site "${s}"`);
    });
    const shiftName = get('shift');
    const shiftId = shiftName ? lookups.shifts.get(key(shiftName)) : undefined;
    if (shiftName && !shiftId) errors.push(`Unknown shift "${shiftName}"`);
    const dutyHours = get('dutyHours');
    const basis = get('salaryBasis').toUpperCase();
    const amount = get('salaryAmount').replace(/[₹,\s]/g, '');
    if ((basis && !amount) || (!basis && amount)) errors.push('Give both salary basis and amount, or neither');
    const candidate = {
      employeeCode: get('employeeCode') || undefined,
      fullName: get('fullName'),
      phone: get('phone'),
      email: get('email') || undefined,
      designation: get('designation') || undefined,
      branchId,
      departmentId,
      dateOfJoining: get('dateOfJoining'),
      siteIds: siteIds.filter((s): s is string => !!s),
      shiftId,
      dutyMinutes: dutyHours ? Math.round(Number(dutyHours) * 60) : undefined,
      salary: basis && amount ? { basis, amount, effectiveFrom: get('dateOfJoining') } : undefined,
    };
    const parsed = employeeCreateSchema.safeParse(candidate);
    if (!parsed.success) {
      errors.push(...parsed.error.issues.filter((i) => i.path[0] !== 'branchId').map((i) => `${i.path.join('.') || 'row'}: ${i.message}`));
    }
    return { rowNo, raw, input: parsed.success && errors.length === 0 ? parsed.data : null, errors };
  }

  /** Duplicate phones/codes inside the file and against existing employees. */
  private async crossCheck(outcomes: readonly RowOutcome[]): Promise<RowOutcome[]> {
    const tenantId = requireTenantId();
    const phones = outcomes.map((o) => normalizeIndianPhone(o.raw['phone'] ?? '')).filter((p): p is string => !!p);
    const codes = outcomes.map((o) => (o.raw['employeeCode'] ?? '').toUpperCase()).filter(Boolean);
    const [takenPhones, takenCodes] = await Promise.all([
      this.db.platform.employee.findMany({ where: { livePhone: { in: phones } }, select: { livePhone: true } }),
      this.db.platform.employee.findMany({ where: { liveCodeKey: { in: codes.map((c) => `${tenantId}:${c}`) } }, select: { liveCodeKey: true } }),
    ]);
    const phoneTaken = new Set(takenPhones.map((p) => p.livePhone));
    const codeTaken = new Set(takenCodes.map((c) => c.liveCodeKey?.split(':')[1]));
    const seenPhones = new Map<string, number>();
    const seenCodes = new Map<string, number>();
    return outcomes.map((o) => {
      const errors = [...o.errors];
      const phone = normalizeIndianPhone(o.raw['phone'] ?? '');
      const code = (o.raw['employeeCode'] ?? '').toUpperCase();
      if (phone && phoneTaken.has(phone)) errors.push('This phone number cannot be used (already registered)');
      if (phone && seenPhones.has(phone)) errors.push(`Same phone as row ${seenPhones.get(phone)}`);
      if (code && codeTaken.has(code)) errors.push('Employee code already used');
      if (code && seenCodes.has(code)) errors.push(`Same employee code as row ${seenCodes.get(code)}`);
      if (phone && !seenPhones.has(phone)) seenPhones.set(phone, o.rowNo);
      if (code && !seenCodes.has(code)) seenCodes.set(code, o.rowNo);
      return { ...o, errors, input: errors.length === 0 ? o.input : null };
    });
  }
}
