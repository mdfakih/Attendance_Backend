import { z } from 'zod';
import { emailSchema, passwordSchema, phoneSchema } from './common.js';

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(128),
  totp: z.string().regex(/^\d{6}$/).optional(),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const refreshSchema = z.object({
  refreshToken: z.string().min(20).max(512),
});
export type RefreshInput = z.infer<typeof refreshSchema>;

export const selectMembershipSchema = z.object({
  refreshToken: z.string().min(20).max(512),
  tenantId: z.uuid(),
});
export type SelectMembershipInput = z.infer<typeof selectMembershipSchema>;

export const forgotPasswordSchema = z.object({ email: emailSchema });
export const resetPasswordSchema = z.object({
  token: z.string().min(20).max(256),
  password: passwordSchema,
});
export const acceptInviteSchema = z.object({
  token: z.string().min(20).max(256),
  fullName: z.string().trim().min(2).max(120),
  password: passwordSchema,
});
export type AcceptInviteInput = z.infer<typeof acceptInviteSchema>;

/** Activation code as typed by the employee: 8 chars, dashes/spaces ignored, case-insensitive. */
export const activationCodeSchema = z
  .string()
  .transform((v) => v.replace(/[\s-]/g, '').toUpperCase())
  .refine((v) => /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/.test(v), 'Enter the 8-character code');

export const deviceInfoSchema = z.object({
  installId: z.uuid(),
  platform: z.enum(['ANDROID', 'IOS']).default('ANDROID'),
  manufacturer: z.string().max(80).default(''),
  model: z.string().max(80).default(''),
  osVersion: z.string().max(40).default(''),
  appVersion: z.string().max(40).default(''),
  androidId: z.string().max(64).nullish(),
});
export type DeviceInfo = z.infer<typeof deviceInfoSchema>;

export const mobileActivateSchema = z.object({
  phone: phoneSchema,
  code: activationCodeSchema,
  nonce: z.string().min(16).max(128),
  /** Base64 SubjectPublicKeyInfo (DER) of the device's P-256 key. */
  publicKey: z.string().min(80).max(400),
  /** Base64 DER ECDSA signature over `v1|ACTIVATE|<nonce>|<phone>`. */
  signature: z.string().min(40).max(200),
  device: deviceInfoSchema,
  /** Null or absent when the phone has no push token (Firebase not set up, or the fetch failed). */
  fcmToken: z.string().max(4096).nullish(),
});
export type MobileActivateInput = z.infer<typeof mobileActivateSchema>;

export const mobileRefreshSchema = z.object({
  refreshToken: z.string().min(20).max(512),
  nonce: z.string().min(16).max(128),
  signature: z.string().min(40).max(200),
});
export type MobileRefreshInput = z.infer<typeof mobileRefreshSchema>;

export const mobilePinResetSchema = z.object({
  phone: phoneSchema,
  code: activationCodeSchema,
  nonce: z.string().min(16).max(128),
  signature: z.string().min(40).max(200),
  installId: z.uuid(),
});
export type MobilePinResetInput = z.infer<typeof mobilePinResetSchema>;

export const bindingStatusSchema = z.object({
  bindingId: z.uuid(),
  nonce: z.string().min(16).max(128),
  signature: z.string().min(40).max(200),
});
export type BindingStatusInput = z.infer<typeof bindingStatusSchema>;

export const fcmTokenSchema = z.object({ fcmToken: z.string().min(10).max(4096) });

export interface TokenPair {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly accessExpiresAt: string;
}
