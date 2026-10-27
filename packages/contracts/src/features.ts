/**
 * Optional per-tenant features. A missing tenant row means the registry default.
 * Effective = enabled AND every `requires` feature is effective.
 */
export const FEATURE_KEYS = [
  'LEAVE',
  'OVERTIME',
  'DEVICE_APPROVAL',
  'AUTO_EMAIL_ACTIVATION_CODES',
  'EMPLOYEE_EARNINGS_VIEW',
] as const;
export type FeatureKey = (typeof FEATURE_KEYS)[number];

export interface FeatureDefinition {
  readonly key: FeatureKey;
  readonly label: string;
  readonly description: string;
  readonly defaultEnabled: boolean;
  readonly requires: readonly FeatureKey[];
}

export const FEATURE_REGISTRY: Readonly<Record<FeatureKey, FeatureDefinition>> = {
  LEAVE: {
    key: 'LEAVE',
    label: 'Leave management',
    description: 'Leave types, balances, employee requests and approvals. Approved leave feeds pay.',
    defaultEnabled: false,
    requires: [],
  },
  OVERTIME: {
    key: 'OVERTIME',
    label: 'Overtime',
    description: 'Count minutes beyond duty hours as overtime, with optional approval.',
    defaultEnabled: false,
    requires: [],
  },
  DEVICE_APPROVAL: {
    key: 'DEVICE_APPROVAL',
    label: 'Approve new devices',
    description: 'A newly activated phone stays pending until an Admin or Manager approves it.',
    defaultEnabled: false,
    requires: [],
  },
  AUTO_EMAIL_ACTIVATION_CODES: {
    key: 'AUTO_EMAIL_ACTIVATION_CODES',
    label: 'Email activation codes',
    description: 'Email the activation code automatically when an employee has an email address.',
    defaultEnabled: false,
    requires: [],
  },
  EMPLOYEE_EARNINGS_VIEW: {
    key: 'EMPLOYEE_EARNINGS_VIEW',
    label: 'Show earnings to employees',
    description: 'Employees see their month-to-date earned pay in the app.',
    defaultEnabled: false,
    requires: [],
  },
};

export type FeatureState = Readonly<Record<FeatureKey, boolean>>;

export function resolveFeatures(rows: ReadonlyArray<{ key: string; enabled: boolean }>): FeatureState {
  const explicit = new Map(rows.map((r) => [r.key, r.enabled]));
  const raw = Object.fromEntries(
    FEATURE_KEYS.map((k) => [k, explicit.get(k) ?? FEATURE_REGISTRY[k].defaultEnabled]),
  ) as Record<FeatureKey, boolean>;
  return Object.fromEntries(
    FEATURE_KEYS.map((k) => [k, raw[k] && FEATURE_REGISTRY[k].requires.every((dep) => raw[dep])]),
  ) as FeatureState;
}
