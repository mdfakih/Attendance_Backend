/**
 * String-literal enums shared by Backend, Web and (mirrored by hand in) the Flutter app.
 * Each is a readonly tuple so it can feed both TypeScript types and Zod enums.
 */

export const TENANT_STATUSES = ['TRIAL', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELLED'] as const;
export type TenantStatus = (typeof TENANT_STATUSES)[number];

export const PAYROLL_TIERS = ['BASIC', 'FULL'] as const;
export type PayrollTier = (typeof PAYROLL_TIERS)[number];

/** Tiers that are implemented and can be assigned today. */
export const AVAILABLE_PAYROLL_TIERS: readonly PayrollTier[] = ['BASIC'];

export const PLATFORM_ROLES = ['SUPERADMIN', 'SUPPORT', 'FINANCE', 'READONLY'] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];

export const ROLE_KINDS = ['ADMIN', 'MANAGER'] as const;
export type RoleKind = (typeof ROLE_KINDS)[number];

export const USER_STATUSES = ['ACTIVE', 'DISABLED'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const EMPLOYEE_STATUSES = ['INVITED', 'ACTIVE', 'DEACTIVATED', 'EXITED'] as const;
export type EmployeeStatus = (typeof EMPLOYEE_STATUSES)[number];

export const BINDING_STATUSES = ['PENDING', 'ACTIVE', 'REVOKED'] as const;
export type BindingStatus = (typeof BINDING_STATUSES)[number];

export const CODE_PURPOSES = ['ACTIVATION', 'PIN_RESET'] as const;
export type CodePurpose = (typeof CODE_PURPOSES)[number];

export const CODE_STATUSES = ['ISSUED', 'USED', 'LOCKED', 'REVOKED', 'EXPIRED'] as const;
export type CodeStatus = (typeof CODE_STATUSES)[number];

export const GEOFENCE_MODES = ['ASSIGNED_SITES', 'ANY_TENANT_SITE'] as const;
export type GeofenceMode = (typeof GEOFENCE_MODES)[number];

export const HOURS_MODES = ['FIRST_IN_LAST_OUT', 'SUM_OF_PAIRS'] as const;
export type HoursMode = (typeof HOURS_MODES)[number];

export const MISSING_OUT_TREATMENTS = ['ABSENT', 'HALF_DAY', 'PRESENT_FLAGGED'] as const;
export type MissingOutTreatment = (typeof MISSING_OUT_TREATMENTS)[number];

export const DAY_TYPES = ['WORKING', 'WEEKLY_OFF', 'HOLIDAY'] as const;
export type DayType = (typeof DAY_TYPES)[number];

export const ATTENDANCE_STATUSES = [
  'NOT_STARTED',
  'IN_PROGRESS',
  'PRESENT',
  'HALF_DAY',
  'ABSENT',
  'MISSING_OUT',
  'LEAVE',
  'HALF_LEAVE',
  'HOLIDAY',
  'WEEKLY_OFF',
] as const;
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];

/** Statuses an employer may set through a manual mark. */
export const MANUAL_MARK_STATUSES = ['PRESENT', 'ABSENT', 'HALF_DAY', 'LEAVE', 'WEEKLY_OFF', 'HOLIDAY'] as const;
export type ManualMarkStatus = (typeof MANUAL_MARK_STATUSES)[number];

/** Where a day stands on counting its outside-hours time. */
export const REG_STATES = ['NOT_APPLICABLE', 'AVAILABLE', 'REQUESTED', 'APPROVED', 'REJECTED'] as const;
export type RegState = (typeof REG_STATES)[number];

export const REG_REQUEST_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'] as const;
export type RegRequestStatus = (typeof REG_REQUEST_STATUSES)[number];

export const PUNCH_DIRECTIONS = ['IN', 'OUT'] as const;
export type PunchDirection = (typeof PUNCH_DIRECTIONS)[number];

export const PUNCH_REJECT_REASONS = [
  'OUTSIDE_GEOFENCE',
  'MOCK_LOCATION',
  'LOW_ACCURACY',
  'NON_WORKING_DAY',
  'ON_LEAVE',
  'BINDING_INACTIVE',
  'BAD_SIGNATURE',
  'NONCE_INVALID',
  'RATE_LIMITED',
  'LIVENESS_INVALID',
  'SELFIE_MISSING',
  'TENANT_SUSPENDED',
  'EMPLOYEE_INACTIVE',
  'CONSENT_REQUIRED',
  'NO_SITES',
] as const;
export type PunchRejectReason = (typeof PUNCH_REJECT_REASONS)[number];

export const LIVENESS_STEPS = ['BLINK', 'TURN_LEFT', 'TURN_RIGHT', 'SMILE'] as const;
export type LivenessStep = (typeof LIVENESS_STEPS)[number];

export const ACCRUAL_MODES = ['NONE', 'FIXED_QUOTA', 'YEARLY_ACCRUAL', 'MONTHLY_ACCRUAL'] as const;
export type AccrualMode = (typeof ACCRUAL_MODES)[number];

export const DAY_PARTS = ['FULL', 'FIRST_HALF', 'SECOND_HALF'] as const;
export type DayPart = (typeof DAY_PARTS)[number];

export const LEAVE_REQUEST_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'] as const;
export type LeaveRequestStatus = (typeof LEAVE_REQUEST_STATUSES)[number];

export const SALARY_BASES = ['MONTHLY', 'WEEKLY', 'HOURLY'] as const;
export type SalaryBasis = (typeof SALARY_BASES)[number];

export const PAYABLE_DAYS_BASES = ['CALENDAR', 'FIXED_26', 'FIXED_30', 'WORKING_DAYS'] as const;
export type PayableDaysBasis = (typeof PAYABLE_DAYS_BASES)[number];

export const PAY_ADJUSTMENT_KINDS = ['ADDITION', 'DEDUCTION'] as const;
export type PayAdjustmentKind = (typeof PAY_ADJUSTMENT_KINDS)[number];

export const PAY_PERIOD_STATUSES = ['OPEN', 'LOCKED'] as const;
export type PayPeriodStatus = (typeof PAY_PERIOD_STATUSES)[number];

export const SUBSCRIPTION_STATUSES = ['TRIALING', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELLED'] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const PAYMENT_METHODS = ['BANK_TRANSFER', 'UPI', 'CHEQUE', 'CASH', 'OTHER'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const EXPORT_TYPES = [
  'ATTENDANCE_REGISTER',
  'ATTENDANCE_DAILY',
  'PUNCH_LOG',
  'SALARY_REGISTER',
  'LEAVE_REGISTER',
  'EMPLOYEE_MASTER',
] as const;
export type ExportType = (typeof EXPORT_TYPES)[number];

export const EXPORT_FORMATS = ['XLSX', 'PDF'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export const JOB_STATUSES = ['QUEUED', 'RUNNING', 'DONE', 'FAILED', 'EXPIRED'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const ACTOR_TYPES = ['EMPLOYEE', 'TENANT_USER', 'PLATFORM_USER', 'SYSTEM'] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

export const AUTH_REALMS = ['EMPLOYEE', 'TENANT_USER', 'PLATFORM_USER'] as const;
export type AuthRealm = (typeof AUTH_REALMS)[number];
