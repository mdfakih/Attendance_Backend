import { z } from 'zod';
import { PAY_ADJUSTMENT_KINDS, PAYABLE_DAYS_BASES } from '../enums.js';
import { moneySchema, monthSchema, paginationQuerySchema, reasonSchema } from './common.js';

export const payAdjustmentSchema = z.object({
  employeeId: z.uuid(),
  month: monthSchema,
  kind: z.enum(PAY_ADJUSTMENT_KINDS),
  label: z.string().trim().min(2).max(60),
  amount: moneySchema,
  reason: reasonSchema,
});
export type PayAdjustmentInput = z.infer<typeof payAdjustmentSchema>;

export const payRegisterQuerySchema = paginationQuerySchema.extend({
  month: monthSchema,
  branchId: z.uuid().optional(),
  departmentId: z.uuid().optional(),
});
export type PayRegisterQuery = z.infer<typeof payRegisterQuerySchema>;

export const payPeriodLockSchema = z.object({ month: monthSchema });
export const payPeriodUnlockSchema = z.object({ month: monthSchema, reason: reasonSchema });

export const paySettingsSchema = z.object({
  payableDaysBasis: z.enum(PAYABLE_DAYS_BASES),
  defaultOtMultiplier: z.coerce.number().min(1).max(4),
});
export type PaySettingsInput = z.infer<typeof paySettingsSchema>;

export interface EarnedPayBreakdown {
  readonly employeeId: string;
  readonly month: string;
  readonly basis: 'MONTHLY' | 'WEEKLY' | 'HOURLY' | null;
  readonly rate: string | null;
  readonly periodDays: number;
  readonly payableDays: string;
  readonly lopDays: string;
  readonly workedMinutes: number;
  readonly overtimeMinutes: number;
  readonly basePay: string;
  readonly overtimePay: string;
  readonly additions: string;
  readonly deductions: string;
  readonly netEarned: string;
  readonly isLocked: boolean;
  readonly asOf: string;
}
