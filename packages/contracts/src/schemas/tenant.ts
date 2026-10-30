import { z } from 'zod';
import { EXPORT_FORMATS, EXPORT_TYPES } from '../enums.js';
import { FEATURE_KEYS } from '../features.js';
import { PERMISSION_ACTIONS, PERMISSION_MODULES } from '../permissions.js';
import { emailSchema, isoDateSchema, monthSchema } from './common.js';

export const tenantSettingsSchema = z.object({
  timezone: z.string().min(3).max(64).optional(),
  activationCodeTtlDays: z.coerce.number().int().min(1).max(30).optional(),
  defaultSiteRadiusM: z.coerce.number().int().min(20).max(2000).optional(),
  defaultMaxAccuracyM: z.coerce.number().int().min(10).max(500).optional(),
  accuracyBufferCapM: z.coerce.number().int().min(0).max(200).optional(),
  selfieRetentionDays: z.coerce.number().int().min(30).max(365).optional(),
  missingOutReminder: z.boolean().optional(),
  /** Company-wide working hours; a branch default and then an employee assignment override it. */
  defaultShiftId: z.uuid().nullable().optional(),
});
export type TenantSettingsInput = z.infer<typeof tenantSettingsSchema>;

export const featureToggleSchema = z.object({
  key: z.enum(FEATURE_KEYS),
  enabled: z.boolean(),
});
export type FeatureToggleInput = z.infer<typeof featureToggleSchema>;

// Partial: a role lists only the modules it can use (z.record with enum keys would demand every module).
const permissionMatrixSchema = z.partialRecord(z.enum(PERMISSION_MODULES), z.array(z.enum(PERMISSION_ACTIONS)));

export const roleSchema = z.object({
  name: z.string().trim().min(2).max(60),
  description: z.string().trim().max(200).optional(),
  permissions: permissionMatrixSchema,
});
export type RoleInput = z.infer<typeof roleSchema>;

export const inviteUserSchema = z.object({
  email: emailSchema,
  fullName: z.string().trim().min(2).max(120),
  roleId: z.uuid(),
  branchIds: z.array(z.uuid()).max(100).default([]),
  departmentIds: z.array(z.uuid()).max(100).default([]),
});
export type InviteUserInput = z.infer<typeof inviteUserSchema>;

export const updateMembershipSchema = z.object({
  roleId: z.uuid().optional(),
  status: z.enum(['ACTIVE', 'DISABLED']).optional(),
  branchIds: z.array(z.uuid()).max(100).optional(),
  departmentIds: z.array(z.uuid()).max(100).optional(),
});
export type UpdateMembershipInput = z.infer<typeof updateMembershipSchema>;

export const exportRequestSchema = z.object({
  type: z.enum(EXPORT_TYPES),
  format: z.enum(EXPORT_FORMATS),
  month: monthSchema.optional(),
  date: isoDateSchema.optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  branchId: z.uuid().optional(),
  departmentId: z.uuid().optional(),
});
export type ExportRequestInput = z.infer<typeof exportRequestSchema>;

export const auditQuerySchema = z.object({
  entityType: z.string().max(60).optional(),
  entityId: z.uuid().optional(),
  actorId: z.uuid().optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  cursor: z.string().max(100).optional(),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
export type AuditQuery = z.infer<typeof auditQuerySchema>;

export const consentAcceptSchema = z.object({
  noticeId: z.uuid(),
  purposes: z.array(z.string().max(40)).min(1).max(20),
});
export type ConsentAcceptInput = z.infer<typeof consentAcceptSchema>;
