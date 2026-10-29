import { describe, expect, it } from 'vitest';
import { mobileActivateSchema } from './auth.js';

const validActivation = {
  phone: '+919876543210',
  code: 'ABCD-EFGH',
  nonce: 'n'.repeat(32),
  publicKey: 'k'.repeat(124),
  signature: 's'.repeat(96),
  device: { installId: '3f2b8c1e-4d5a-4b6c-8e7f-9a0b1c2d3e4f', platform: 'ANDROID' },
};

describe('mobileActivateSchema', () => {
  it('accepts a request without fcmToken or androidId', () => {
    expect(mobileActivateSchema.safeParse(validActivation).success).toBe(true);
  });

  // Phones without Firebase (or whose token fetch failed) send null instead of leaving the field out.
  it('accepts null fcmToken and null androidId', () => {
    const result = mobileActivateSchema.safeParse({
      ...validActivation,
      fcmToken: null,
      device: { ...validActivation.device, androidId: null },
    });
    expect(result.success).toBe(true);
  });

  it('still rejects an fcmToken that is not a string', () => {
    expect(mobileActivateSchema.safeParse({ ...validActivation, fcmToken: 42 }).success).toBe(false);
  });
});
