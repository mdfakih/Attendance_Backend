import { z } from 'zod';
import { brandingSchema } from '../branding.js';
import { PAYMENT_METHODS, PAYROLL_TIERS, PLATFORM_ROLES, SUBSCRIPTION_STATUSES } from '../enums.js';
import { FEATURE_KEYS } from '../features.js';
import { emailSchema, isoDateSchema, moneySchema, reasonSchema } from './common.js';

const stateCodeSchema = z.string().regex(/^[A-Z]{2}$/, 'Use the 2-letter state code, e.g. MH');
const gstinSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, 'Enter a valid GSTIN');

export const createTenantSchema = z.object({
  legalName: z.string().trim().min(2).max(200),
  displayName: z.string().trim().min(2).max(80),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/, 'Use 3–40 lowercase letters, digits or dashes'),
  gstin: gstinSchema.optional(),
  stateCode: stateCodeSchema,
  billingEmail: emailSchema,
  timezone: z.string().default('Asia/Kolkata'),
  payrollTier: z.enum(PAYROLL_TIERS).default('BASIC'),
  planId: z.uuid(),
  trialDays: z.coerce.number().int().min(0).max(90).default(14),
  employeeCap: z.coerce.number().int().min(1).max(100000).optional(),
  admin: z.object({
    fullName: z.string().trim().min(2).max(120),
    email: emailSchema,
  }),
  branding: brandingSchema.optional(),
});
export type CreateTenantInput = z.infer<typeof createTenantSchema>;

export const updateTenantSchema = z.object({
  displayName: z.string().trim().min(2).max(80).optional(),
  legalName: z.string().trim().min(2).max(200).optional(),
  gstin: gstinSchema.nullable().optional(),
  stateCode: stateCodeSchema.optional(),
  billingEmail: emailSchema.optional(),
  payrollTier: z.enum(PAYROLL_TIERS).optional(),
  employeeCap: z.coerce.number().int().min(1).max(100000).nullable().optional(),
});
export type UpdateTenantInput = z.infer<typeof updateTenantSchema>;

/**
 * Platform team switching a client's module or option on/off, and/or locking it so the client's Admin
 * cannot change it. Omitted fields keep their stored value.
 */
export const platformFeatureSchema = z
  .object({
    key: z.enum(FEATURE_KEYS),
    enabled: z.boolean().optional(),
    locked: z.boolean().optional(),
  })
  .refine((v) => v.enabled !== undefined || v.locked !== undefined, 'Send enabled, locked or both.');
export type PlatformFeatureInput = z.infer<typeof platformFeatureSchema>;

export const tenantStatusChangeSchema = z.object({ reason: reasonSchema });

export const planSchema = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_]{2,30}$/),
  name: z.string().trim().min(2).max(80),
  pricePerEmployee: moneySchema,
  minBillableEmployees: z.coerce.number().int().min(0).default(0),
  defaultEmployeeCap: z.coerce.number().int().min(1).nullable().optional(),
  trialDays: z.coerce.number().int().min(0).max(90).default(14),
  active: z.boolean().default(true),
});
export type PlanInput = z.infer<typeof planSchema>;

export const updateSubscriptionSchema = z.object({
  planId: z.uuid().optional(),
  status: z.enum(SUBSCRIPTION_STATUSES).optional(),
  currentPeriodStart: isoDateSchema.optional(),
  currentPeriodEnd: isoDateSchema.optional(),
  amountDue: moneySchema.optional(),
  dueDate: isoDateSchema.nullable().optional(),
  pricePerEmployeeOverride: moneySchema.nullable().optional(),
  notes: z.string().max(1000).optional(),
});
export type UpdateSubscriptionInput = z.infer<typeof updateSubscriptionSchema>;

export const recordPaymentSchema = z.object({
  amount: moneySchema,
  method: z.enum(PAYMENT_METHODS),
  referenceNo: z.string().trim().max(80).optional(),
  receivedOn: isoDateSchema,
  periodStart: isoDateSchema.optional(),
  periodEnd: isoDateSchema.optional(),
  notes: z.string().max(1000).optional(),
});
export type RecordPaymentInput = z.infer<typeof recordPaymentSchema>;

export const createPlatformUserSchema = z.object({
  email: emailSchema,
  fullName: z.string().trim().min(2).max(120),
  role: z.enum(PLATFORM_ROLES),
});
export type CreatePlatformUserInput = z.infer<typeof createPlatformUserSchema>;
