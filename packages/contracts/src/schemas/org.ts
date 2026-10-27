import { z } from 'zod';
import { GEOFENCE_MODES, HOURS_MODES, MISSING_OUT_TREATMENTS } from '../enums.js';
import { isoDateSchema, reasonSchema, timeOfDaySchema } from './common.js';

export const branchSchema = z.object({
  name: z.string().trim().min(2).max(80),
  code: z.string().trim().max(20).optional(),
  stateCode: z.string().regex(/^[A-Z]{2}$/),
  address: z.string().trim().max(300).optional(),
  holidayCalendarId: z.uuid().nullable().optional(),
  weeklyOffPatternId: z.uuid().nullable().optional(),
  defaultShiftId: z.uuid().nullable().optional(),
  active: z.boolean().default(true),
});
export type BranchInput = z.infer<typeof branchSchema>;

export const departmentSchema = z.object({
  name: z.string().trim().min(2).max(80),
  code: z.string().trim().max(20).optional(),
  active: z.boolean().default(true),
});
export type DepartmentInput = z.infer<typeof departmentSchema>;

export const siteSchema = z.object({
  name: z.string().trim().min(2).max(80),
  branchId: z.uuid().nullable().optional(),
  address: z.string().trim().max(300).optional(),
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  radiusM: z.coerce.number().int().min(20).max(2000),
  maxAccuracyM: z.coerce.number().int().min(10).max(500).default(100),
  active: z.boolean().default(true),
});
export type SiteInput = z.infer<typeof siteSchema>;

export const policySchema = z.object({
  name: z.string().trim().min(2).max(80),
  hoursMode: z.enum(HOURS_MODES).default('FIRST_IN_LAST_OUT'),
  lateGraceMin: z.coerce.number().int().min(0).max(240).default(10),
  earlyLeaveGraceMin: z.coerce.number().int().min(0).max(240).default(10),
  fullDayMinMinutes: z.coerce.number().int().min(60).max(1440).nullable().optional(),
  halfDayMinMinutes: z.coerce.number().int().min(30).max(1440).default(240),
  missingOutTreatment: z.enum(MISSING_OUT_TREATMENTS).default('ABSENT'),
  minPunchGapSec: z.coerce.number().int().min(0).max(3600).default(60),
  blockMockLocation: z.boolean().default(true),
  otMinMinutes: z.coerce.number().int().min(0).max(600).default(30),
  otRoundingMinutes: z.coerce.number().int().min(1).max(60).default(15),
  otDailyCapMinutes: z.coerce.number().int().min(0).max(960).default(240),
  otRequiresApproval: z.boolean().default(true),
});
export type PolicyInput = z.infer<typeof policySchema>;

export const shiftSchema = z.object({
  name: z.string().trim().min(2).max(80),
  code: z.string().trim().max(20).optional(),
  startTime: timeOfDaySchema,
  endTime: timeOfDaySchema,
  dutyMinutes: z.coerce.number().int().min(60).max(1440),
  unpaidBreakMinutes: z.coerce.number().int().min(0).max(240).default(0),
  isFlexible: z.boolean().default(false),
  windowBeforeStartMin: z.coerce.number().int().min(0).max(720).default(120),
  windowAfterEndMin: z.coerce.number().int().min(0).max(720).default(360),
  policyId: z.uuid().nullable().optional(),
  active: z.boolean().default(true),
});
export type ShiftInput = z.infer<typeof shiftSchema>;

export const shiftAssignmentSchema = z.object({
  employeeIds: z.array(z.uuid()).min(1).max(1000),
  shiftId: z.uuid(),
  effectiveFrom: isoDateSchema,
});
export type ShiftAssignmentInput = z.infer<typeof shiftAssignmentSchema>;

/** Weekly-off rule: day of week (0 = Sunday) and which weeks of the month (ALL or e.g. [2,4]). */
export const weeklyOffRuleSchema = z.object({
  dow: z.number().int().min(0).max(6),
  weeks: z.union([z.literal('ALL'), z.array(z.number().int().min(1).max(5)).min(1)]),
});
export type WeeklyOffRule = z.infer<typeof weeklyOffRuleSchema>;

export const weeklyOffPatternSchema = z.object({
  name: z.string().trim().min(2).max(80),
  rules: z.array(weeklyOffRuleSchema).max(14),
});
export type WeeklyOffPatternInput = z.infer<typeof weeklyOffPatternSchema>;

export const holidayCalendarSchema = z.object({
  name: z.string().trim().min(2).max(80),
  isDefault: z.boolean().default(false),
});
export type HolidayCalendarInput = z.infer<typeof holidayCalendarSchema>;

export const holidaySchema = z.object({
  holidayDate: isoDateSchema,
  name: z.string().trim().min(2).max(80),
  kind: z.enum(['NATIONAL', 'FESTIVAL', 'COMPANY', 'OPTIONAL']).default('COMPANY'),
  isPaid: z.boolean().default(true),
});
export type HolidayInput = z.infer<typeof holidaySchema>;

export const dayOverrideSchema = z.object({
  employeeIds: z.array(z.uuid()).min(1).max(500),
  dates: z.array(isoDateSchema).min(1).max(31),
  allowPunch: z.boolean().default(true),
  reason: reasonSchema,
});
export type DayOverrideInput = z.infer<typeof dayOverrideSchema>;

export const geofenceModeSchema = z.enum(GEOFENCE_MODES);
