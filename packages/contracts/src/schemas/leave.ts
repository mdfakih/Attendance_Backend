import { z } from 'zod';
import { ACCRUAL_MODES, DAY_PARTS, LEAVE_REQUEST_STATUSES } from '../enums.js';
import { isoDateSchema, paginationQuerySchema, reasonSchema } from './common.js';

const daysSchema = z.coerce.number().min(0).max(366);

export const leaveTypeSchema = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_]{1,10}$/),
  name: z.string().trim().min(2).max(60),
  isPaid: z.boolean(),
  allowHalfDay: z.boolean().default(true),
  accrualMode: z.enum(ACCRUAL_MODES).default('NONE'),
  annualQuota: daysSchema.nullable().optional(),
  monthlyAccrual: daysSchema.nullable().optional(),
  carryForwardCap: daysSchema.nullable().optional(),
  maxNegativeBalance: daysSchema.default(0),
  backdateLimitDays: z.coerce.number().int().min(0).max(365).default(7),
  countNonWorkingDays: z.boolean().default(false),
  active: z.boolean().default(true),
});
export type LeaveTypeInput = z.infer<typeof leaveTypeSchema>;

export const leaveApplySchema = z
  .object({
    leaveTypeId: z.uuid(),
    fromDate: isoDateSchema,
    fromPart: z.enum(DAY_PARTS).default('FULL'),
    toDate: isoDateSchema,
    toPart: z.enum(DAY_PARTS).default('FULL'),
    reason: z.string().trim().min(3).max(500),
  })
  .refine((v) => v.toDate >= v.fromDate, { message: 'End date must be on or after start date', path: ['toDate'] });
export type LeaveApplyInput = z.infer<typeof leaveApplySchema>;

export const leaveApplyOnBehalfSchema = leaveApplySchema.and(z.object({ employeeId: z.uuid() }));
export type LeaveApplyOnBehalfInput = z.infer<typeof leaveApplyOnBehalfSchema>;

export const leaveDecisionSchema = z.object({ note: z.string().trim().max(300).optional() });

export const leaveBalanceAdjustSchema = z.object({
  employeeId: z.uuid(),
  leaveTypeId: z.uuid(),
  days: z.coerce.number().min(-366).max(366).refine((d) => d !== 0, 'Enter a non-zero number of days'),
  reason: reasonSchema,
});
export type LeaveBalanceAdjustInput = z.infer<typeof leaveBalanceAdjustSchema>;

export const leaveListQuerySchema = paginationQuerySchema.extend({
  status: z.enum(LEAVE_REQUEST_STATUSES).optional(),
  employeeId: z.uuid().optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
});
export type LeaveListQuery = z.infer<typeof leaveListQuerySchema>;
