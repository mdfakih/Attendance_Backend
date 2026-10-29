/**
 * Optional per-tenant features. A missing tenant row means the registry default.
 * Effective = enabled AND every `requires` feature is effective.
 *
 * MODULE features switch a whole area of the product on or off (menu items, screens and API);
 * OPTION features change how an enabled area behaves. The platform team can lock any feature
 * so the client's own Admin cannot change it.
 */
export const FEATURE_KEYS = [
  'LEAVE',
  'OVERTIME',
  'EXTRA_TIME',
  'LIVE_MAP',
  'PAY_MONITORING',
  'EXPORTS',
  'BULK_IMPORT',
  'DEVICE_APPROVAL',
  'AUTO_EMAIL_ACTIVATION_CODES',
  'EMPLOYEE_EARNINGS_VIEW',
] as const;
export type FeatureKey = (typeof FEATURE_KEYS)[number];

export const FEATURE_CATEGORIES = ['MODULE', 'OPTION'] as const;
export type FeatureCategory = (typeof FEATURE_CATEGORIES)[number];

export interface FeatureDefinition {
  readonly key: FeatureKey;
  readonly label: string;
  readonly description: string;
  readonly category: FeatureCategory;
  readonly defaultEnabled: boolean;
  readonly requires: readonly FeatureKey[];
}

export const FEATURE_REGISTRY: Readonly<Record<FeatureKey, FeatureDefinition>> = {
  LEAVE: {
    key: 'LEAVE',
    label: 'Leave management',
    description: 'Leave types, balances, employee requests and approvals. Approved leave feeds pay.',
    category: 'MODULE',
    defaultEnabled: false,
    requires: [],
  },
  OVERTIME: {
    key: 'OVERTIME',
    label: 'Overtime',
    description: 'Count minutes beyond duty hours as overtime, with optional approval.',
    category: 'MODULE',
    defaultEnabled: false,
    requires: [],
  },
  EXTRA_TIME: {
    key: 'EXTRA_TIME',
    label: 'Extra time requests',
    description: 'Employees ask for time worked outside working hours to be counted; managers approve it.',
    category: 'MODULE',
    defaultEnabled: true,
    requires: [],
  },
  LIVE_MAP: {
    key: 'LIVE_MAP',
    label: 'Live map',
    description: 'See where today’s punches happened on a map.',
    category: 'MODULE',
    defaultEnabled: true,
    requires: [],
  },
  PAY_MONITORING: {
    key: 'PAY_MONITORING',
    label: 'Pay monitoring',
    description: 'Salary register, earned pay, adjustments and month locking.',
    category: 'MODULE',
    defaultEnabled: true,
    requires: [],
  },
  EXPORTS: {
    key: 'EXPORTS',
    label: 'Reports & exports',
    description: 'Download attendance, punch, leave and salary reports as Excel or PDF.',
    category: 'MODULE',
    defaultEnabled: true,
    requires: [],
  },
  BULK_IMPORT: {
    key: 'BULK_IMPORT',
    label: 'Bulk employee upload',
    description: 'Add many employees at once from an Excel sheet.',
    category: 'MODULE',
    defaultEnabled: true,
    requires: [],
  },
  DEVICE_APPROVAL: {
    key: 'DEVICE_APPROVAL',
    label: 'Approve new devices',
    description: 'A newly activated phone stays pending until an Admin or Manager approves it.',
    category: 'OPTION',
    defaultEnabled: false,
    requires: [],
  },
  AUTO_EMAIL_ACTIVATION_CODES: {
    key: 'AUTO_EMAIL_ACTIVATION_CODES',
    label: 'Email activation codes',
    description: 'Email the activation code automatically when an employee has an email address.',
    category: 'OPTION',
    defaultEnabled: false,
    requires: [],
  },
  EMPLOYEE_EARNINGS_VIEW: {
    key: 'EMPLOYEE_EARNINGS_VIEW',
    label: 'Show earnings to employees',
    description: 'Employees see their month-to-date earned pay in the app.',
    category: 'OPTION',
    defaultEnabled: false,
    requires: ['PAY_MONITORING'],
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

/** One feature as an Admin or the platform team sees it. */
export interface FeatureView extends FeatureDefinition {
  readonly enabled: boolean;
  /** Set by the platform team; the client's Admin cannot change a locked feature. */
  readonly locked: boolean;
}

export function featureViews(
  state: FeatureState,
  rows: ReadonlyArray<{ key: string; lockedByPlatform: boolean }>,
): FeatureView[] {
  const locks = new Map(rows.map((r) => [r.key, r.lockedByPlatform]));
  return FEATURE_KEYS.map((key) => ({ ...FEATURE_REGISTRY[key], enabled: state[key], locked: locks.get(key) ?? false }));
}
