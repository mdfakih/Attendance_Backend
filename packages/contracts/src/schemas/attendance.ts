import { z } from 'zod';
import { ATTENDANCE_STATUSES, LIVENESS_STEPS, MANUAL_MARK_STATUSES, REG_REQUEST_STATUSES } from '../enums.js';
import { isoDateSchema, monthSchema, paginationQuerySchema, reasonSchema } from './common.js';

export const manualMarkSchema = z
  .object({
    employeeId: z.uuid(),
    date: isoDateSchema,
    status: z.enum(MANUAL_MARK_STATUSES),
    leaveTypeId: z.uuid().optional(),
    reason: reasonSchema,
  })
  .refine((v) => v.status !== 'LEAVE' || v.leaveTypeId, {
    message: 'Choose a leave type',
    path: ['leaveTypeId'],
  });
export type ManualMarkInput = z.infer<typeof manualMarkSchema>;

export const revokeMarkSchema = z.object({
  employeeId: z.uuid(),
  date: isoDateSchema,
  reason: reasonSchema,
});
export type RevokeMarkInput = z.infer<typeof revokeMarkSchema>;

export const attendanceDailyQuerySchema = paginationQuerySchema.extend({
  date: isoDateSchema,
  branchId: z.uuid().optional(),
  departmentId: z.uuid().optional(),
  siteId: z.uuid().optional(),
  status: z.enum(ATTENDANCE_STATUSES).optional(),
  late: z.coerce.boolean().optional(),
});
export type AttendanceDailyQuery = z.infer<typeof attendanceDailyQuerySchema>;

export const attendanceRegisterQuerySchema = paginationQuerySchema.extend({
  month: monthSchema,
  branchId: z.uuid().optional(),
  departmentId: z.uuid().optional(),
});
export type AttendanceRegisterQuery = z.infer<typeof attendanceRegisterQuerySchema>;

export const employeeMonthQuerySchema = z.object({ month: monthSchema });

export const dashboardQuerySchema = z.object({
  date: isoDateSchema.optional(),
  branchId: z.uuid().optional(),
  departmentId: z.uuid().optional(),
  siteId: z.uuid().optional(),
});
export type DashboardQuery = z.infer<typeof dashboardQuerySchema>;

// ---- Regularization: counting time worked outside working hours ---------------

export const regularizationRequestSchema = z.object({
  date: isoDateSchema,
  reason: reasonSchema,
});
export type RegularizationRequestInput = z.infer<typeof regularizationRequestSchema>;

/** `approvedMinutes` omitted on approval = all outside minutes of the day. */
export const regularizationDecisionSchema = z.object({
  decision: z.enum(['APPROVED', 'REJECTED']),
  approvedMinutes: z.coerce.number().int().min(1).max(1440).optional(),
  note: z.string().trim().max(300).optional(),
});
export type RegularizationDecisionInput = z.infer<typeof regularizationDecisionSchema>;

export const regularizationListQuerySchema = paginationQuerySchema.extend({
  status: z.enum(REG_REQUEST_STATUSES).optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
});
export type RegularizationListQuery = z.infer<typeof regularizationListQuerySchema>;

// ---- Mobile punch flow -------------------------------------------------------

export const locationFixSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracyM: z.number().min(0).max(5000),
  isMock: z.boolean(),
});
export type LocationFix = z.infer<typeof locationFixSchema>;

export const punchIntentSchema = locationFixSchema;
export type PunchIntentInput = z.infer<typeof punchIntentSchema>;

export const livenessResultSchema = z.object({
  passed: z.boolean(),
  steps: z.array(z.enum(LIVENESS_STEPS)).min(1).max(4),
  durationMs: z.number().int().min(0).max(120000),
  faceCount: z.number().int().min(0).max(10),
});
export type LivenessResult = z.infer<typeof livenessResultSchema>;

export const selfieUploadRequestSchema = z.object({
  intentId: z.uuid(),
  sizeBytes: z.number().int().min(10_000).max(800_000),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export type SelfieUploadRequest = z.infer<typeof selfieUploadRequestSchema>;

export const punchCommitSchema = locationFixSchema.extend({
  intentId: z.uuid(),
  deviceTime: z.iso.datetime({ offset: true }),
  liveness: livenessResultSchema,
  selfieSha256: z.string().regex(/^[a-f0-9]{64}$/),
  nonce: z.string().min(16).max(128),
  /** ES256 over `v1|PUNCH|<nonce>|<intentId>|<selfieSha256>|<lat>|<lng>`. */
  signature: z.string().min(40).max(200),
});
export type PunchCommitInput = z.infer<typeof punchCommitSchema>;
