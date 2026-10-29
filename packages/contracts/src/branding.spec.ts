import { describe, expect, it } from 'vitest';
import { BRAND_PRESETS, brandingSchema, DEFAULT_BRANDING, resolveBranding } from './branding.js';
import { featureViews, resolveFeatures } from './features.js';
import { platformFeatureSchema } from './schemas/platform.js';

describe('brandingSchema', () => {
  it('accepts valid colours and an https logo, upper-casing the hex', () => {
    const parsed = brandingSchema.parse({ primaryColor: '#0f766e', accentColor: '#8B5CF6', logoUrl: 'https://cdn.example.com/logo.png' });
    expect(parsed).toEqual({ primaryColor: '#0F766E', accentColor: '#8B5CF6', logoUrl: 'https://cdn.example.com/logo.png' });
  });

  it.each([
    [{ primaryColor: 'red', accentColor: '#000000', logoUrl: null }],
    [{ primaryColor: '#12345', accentColor: '#000000', logoUrl: null }],
    [{ primaryColor: '#123456', accentColor: '#000000', logoUrl: 'http://insecure.example.com/logo.png' }],
    [{ primaryColor: '#123456', accentColor: '#000000', logoUrl: 'javascript:alert(1)' }],
    [{ primaryColor: '#123456', accentColor: '#000000', logoUrl: 'https://x.example.com/a"onerror="x' }],
  ])('rejects %o', (input) => {
    expect(brandingSchema.safeParse(input).success).toBe(false);
  });

  it('every preset passes the schema', () => {
    for (const preset of BRAND_PRESETS) {
      expect(brandingSchema.safeParse({ primaryColor: preset.primaryColor, accentColor: preset.accentColor, logoUrl: null }).success).toBe(true);
    }
  });
});

describe('resolveBranding', () => {
  it('falls back to defaults for empty or unknown values', () => {
    expect(resolveBranding({})).toEqual(DEFAULT_BRANDING);
    expect(resolveBranding(null)).toEqual(DEFAULT_BRANDING);
    expect(resolveBranding('nope')).toEqual(DEFAULT_BRANDING);
  });

  it('keeps valid fields and replaces only the invalid ones', () => {
    expect(resolveBranding({ primaryColor: '#be123c', accentColor: 'blue', logoUrl: 'ftp://x' })).toEqual({
      primaryColor: '#BE123C',
      accentColor: DEFAULT_BRANDING.accentColor,
      logoUrl: null,
    });
  });
});

describe('feature registry', () => {
  it('turns new modules on by default so existing clients keep them', () => {
    const state = resolveFeatures([]);
    expect(state.LIVE_MAP).toBe(true);
    expect(state.PAY_MONITORING).toBe(true);
    expect(state.EXPORTS).toBe(true);
    expect(state.BULK_IMPORT).toBe(true);
    expect(state.EXTRA_TIME).toBe(true);
  });

  it('turns employee earnings off when pay monitoring is off', () => {
    const state = resolveFeatures([
      { key: 'EMPLOYEE_EARNINGS_VIEW', enabled: true },
      { key: 'PAY_MONITORING', enabled: false },
    ]);
    expect(state.EMPLOYEE_EARNINGS_VIEW).toBe(false);
  });

  it('reports platform locks per feature', () => {
    const views = featureViews(resolveFeatures([]), [{ key: 'LEAVE', lockedByPlatform: true }]);
    expect(views.find((v) => v.key === 'LEAVE')?.locked).toBe(true);
    expect(views.find((v) => v.key === 'EXPORTS')?.locked).toBe(false);
    expect(views.every((v) => v.category === 'MODULE' || v.category === 'OPTION')).toBe(true);
  });
});

describe('platformFeatureSchema', () => {
  it('accepts a lock-only or switch-only change', () => {
    expect(platformFeatureSchema.safeParse({ key: 'LEAVE', locked: true }).success).toBe(true);
    expect(platformFeatureSchema.safeParse({ key: 'LEAVE', enabled: false }).success).toBe(true);
    expect(platformFeatureSchema.safeParse({ key: 'LEAVE', enabled: true, locked: false }).success).toBe(true);
  });

  it('rejects a change with nothing to change or an unknown key', () => {
    expect(platformFeatureSchema.safeParse({ key: 'LEAVE' }).success).toBe(false);
    expect(platformFeatureSchema.safeParse({ key: 'NOPE', enabled: true }).success).toBe(false);
  });
});
