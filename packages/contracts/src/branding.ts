import { z } from 'zod';

/**
 * A client's look: brand colours and an optional logo. Set by the platform team and applied
 * to the client's web dashboard and to their employees' mobile app.
 */
export interface Branding {
  /** Buttons, links, active navigation. `#RRGGBB`. */
  readonly primaryColor: string;
  /** Highlights, charts and secondary actions. `#RRGGBB`. */
  readonly accentColor: string;
  /** https link to a square-ish logo (PNG, SVG or JPG); null shows the company initials. */
  readonly logoUrl: string | null;
}

export const DEFAULT_BRANDING: Branding = {
  primaryColor: '#4F46E5',
  accentColor: '#0EA5E9',
  logoUrl: null,
};

export interface BrandPreset {
  readonly key: string;
  readonly label: string;
  readonly primaryColor: string;
  readonly accentColor: string;
}

/** Ready-made colour pairs with good contrast in light and dark mode. */
export const BRAND_PRESETS: readonly BrandPreset[] = [
  { key: 'indigo', label: 'Indigo', primaryColor: '#4F46E5', accentColor: '#0EA5E9' },
  { key: 'ocean', label: 'Ocean', primaryColor: '#0369A1', accentColor: '#14B8A6' },
  { key: 'emerald', label: 'Emerald', primaryColor: '#047857', accentColor: '#F59E0B' },
  { key: 'royal', label: 'Royal', primaryColor: '#6D28D9', accentColor: '#EC4899' },
  { key: 'crimson', label: 'Crimson', primaryColor: '#BE123C', accentColor: '#F97316' },
  { key: 'sunset', label: 'Sunset', primaryColor: '#C2410C', accentColor: '#EAB308' },
  { key: 'graphite', label: 'Graphite', primaryColor: '#334155', accentColor: '#6366F1' },
  { key: 'teal', label: 'Teal', primaryColor: '#0F766E', accentColor: '#8B5CF6' },
];

const hexColorSchema = z
  .string()
  .trim()
  .regex(/^#[0-9A-Fa-f]{6}$/, 'Use a colour like #4F46E5')
  .transform((v) => v.toUpperCase());

const logoUrlSchema = z
  .string()
  .trim()
  .max(500)
  .regex(/^https:\/\/[^\s"'<>]+$/, 'Use an https:// link to the logo image');

export const brandingSchema = z.object({
  primaryColor: hexColorSchema,
  accentColor: hexColorSchema,
  logoUrl: logoUrlSchema.nullable(),
});
export type BrandingInput = z.infer<typeof brandingSchema>;

/** Stored branding with defaults for anything missing or invalid; never throws. */
export function resolveBranding(raw: unknown): Branding {
  const value = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const pick = <K extends keyof Branding>(key: K, schema: z.ZodType<Branding[K]>): Branding[K] => {
    const parsed = schema.safeParse(value[key]);
    return parsed.success ? parsed.data : DEFAULT_BRANDING[key];
  };
  return {
    primaryColor: pick('primaryColor', hexColorSchema),
    accentColor: pick('accentColor', hexColorSchema),
    logoUrl: pick('logoUrl', logoUrlSchema.nullable()),
  };
}
