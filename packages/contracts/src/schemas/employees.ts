import { z } from 'zod';
import { EMPLOYEE_STATUSES, GEOFENCE_MODES, SALARY_BASES } from '../enums.js';
import { emailSchema, isoDateSchema, moneySchema, paginationQuerySchema, phoneSchema, reasonSchema } from './common.js';

export const salaryInputSchema = z.object({
  basis: z.enum(SALARY_BASES),
  amount: moneySchema,
  effectiveFrom: isoDateSchema,
  otMultiplier: z.coerce.number().min(1).max(4).nullable().optional(),
  revisionReason: z.string().trim().max(300).optional(),
});
export type SalaryInput = z.infer<typeof salaryInputSchema>;

export const employeeCreateSchema = z.object({
  employeeCode: z.string().trim().max(30).optional(),
  fullName: z.string().trim().min(2).max(120),
  phone: phoneSchema,
  email: emailSchema.optional(),
  designation: z.string().trim().max(80).optional(),
  branchId: z.uuid(),
  departmentId: z.uuid().nullable().optional(),
  dateOfJoining: isoDateSchema,
  siteIds: z.array(z.uuid()).max(50).default([]),
  geofenceMode: z.enum(GEOFENCE_MODES).default('ASSIGNED_SITES'),
  shiftId: z.uuid().nullable().optional(),
  weeklyOffPatternId: z.uuid().nullable().optional(),
  dutyMinutes: z.coerce.number().int().min(60).max(1440).nullable().optional(),
  salary: salaryInputSchema.optional(),
});
export type EmployeeCreateInput = z.infer<typeof employeeCreateSchema>;

export const employeeUpdateSchema = employeeCreateSchema
  .omit({ salary: true, dateOfJoining: true })
  .partial()
  .extend({ dateOfJoining: isoDateSchema.optional() });
export type EmployeeUpdateInput = z.infer<typeof employeeUpdateSchema>;

export const employeeListQuerySchema = paginationQuerySchema.extend({
  status: z.enum(EMPLOYEE_STATUSES).optional(),
  branchId: z.uuid().optional(),
  departmentId: z.uuid().optional(),
  siteId: z.uuid().optional(),
  deviceStatus: z.enum(['NONE', 'PENDING', 'ACTIVE']).optional(),
});
export type EmployeeListQuery = z.infer<typeof employeeListQuerySchema>;

export const employeeDeactivateSchema = z.object({
  reason: reasonSchema,
  exitDate: isoDateSchema.optional(),
  exited: z.boolean().default(false),
});
export type EmployeeDeactivateInput = z.infer<typeof employeeDeactivateSchema>;

export const releaseDeviceSchema = z.object({ reason: reasonSchema });
export type ReleaseDeviceInput = z.infer<typeof releaseDeviceSchema>;

export const bindingDecisionSchema = z.object({ note: z.string().trim().max(300).optional() });

export const bulkCodesSchema = z.object({
  employeeIds: z.array(z.uuid()).min(1).max(5000),
});
export type BulkCodesInput = z.infer<typeof bulkCodesSchema>;

/** Columns of the bulk-upload template, in order. Keep in sync with the template generator. */
export const EMPLOYEE_IMPORT_COLUMNS = [
  { key: 'employeeCode', header: 'Employee code (optional)', required: false },
  { key: 'fullName', header: 'Full name', required: true },
  { key: 'phone', header: 'Mobile number', required: true },
  { key: 'email', header: 'Email (optional)', required: false },
  { key: 'designation', header: 'Designation (optional)', required: false },
  { key: 'branch', header: 'Branch', required: true },
  { key: 'department', header: 'Department (optional)', required: false },
  { key: 'sites', header: 'Sites (comma separated)', required: false },
  { key: 'shift', header: 'Shift (optional)', required: false },
  { key: 'dateOfJoining', header: 'Date of joining (YYYY-MM-DD)', required: true },
  { key: 'dutyHours', header: 'Duty hours per day (optional)', required: false },
  { key: 'salaryBasis', header: 'Salary basis (MONTHLY / WEEKLY / HOURLY)', required: false },
  { key: 'salaryAmount', header: 'Salary amount in INR', required: false },
] as const;
export type EmployeeImportColumnKey = (typeof EMPLOYEE_IMPORT_COLUMNS)[number]['key'];
