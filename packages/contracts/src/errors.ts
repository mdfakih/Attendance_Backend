/**
 * Stable error codes returned in the API envelope (`error.code`).
 * Clients map codes to user-facing text; the message here is the English default.
 */
export const ERROR_CODES = {
  VALIDATION_FAILED: { status: 400, message: 'Some fields are invalid.' },
  BAD_REQUEST: { status: 400, message: 'The request could not be processed.' },
  UNAUTHENTICATED: { status: 401, message: 'Please sign in again.' },
  TOKEN_EXPIRED: { status: 401, message: 'Your session has expired.' },
  PERMISSIONS_CHANGED: { status: 401, message: 'Your permissions changed. Refreshing your session.' },
  INVALID_CREDENTIALS: { status: 401, message: 'Email or password is incorrect.' },
  MFA_REQUIRED: { status: 401, message: 'Enter the code from your authenticator app.' },
  ACCOUNT_LOCKED: { status: 423, message: 'Too many attempts. Try again later.' },
  FORBIDDEN: { status: 403, message: 'You do not have permission to do this.' },
  FEATURE_DISABLED: { status: 404, message: 'This feature is not enabled for your company.' },
  FEATURE_LOCKED: { status: 403, message: 'This module is managed by your service provider.' },
  NOT_FOUND: { status: 404, message: 'Not found.' },
  CONFLICT: { status: 409, message: 'This conflicts with existing data.' },
  RATE_LIMITED: { status: 429, message: 'Too many requests. Please wait and try again.' },
  INTERNAL_ERROR: { status: 500, message: 'Something went wrong. Please try again.' },

  TENANT_SUSPENDED: { status: 403, message: 'This company account is suspended.' },
  PLAN_LIMIT: { status: 422, message: 'Your plan limit has been reached.' },
  PAYROLL_TIER_UNAVAILABLE: { status: 422, message: 'This payroll tier is not available yet.' },

  PHONE_UNAVAILABLE: { status: 409, message: 'This phone number cannot be used.' },
  EMPLOYEE_CODE_TAKEN: { status: 409, message: 'This employee code is already used.' },
  EMPLOYEE_INACTIVE: { status: 403, message: 'This employee is not active.' },

  ACTIVATION_FAILED: { status: 401, message: 'Check your phone number and code, or contact your employer.' },
  DEVICE_BOUND: { status: 409, message: 'A device is already registered for this employee.' },
  BINDING_PENDING: { status: 403, message: 'Your device is waiting for approval.' },
  BINDING_INACTIVE: { status: 401, message: 'This phone is no longer registered. Contact your employer.' },
  BAD_SIGNATURE: { status: 401, message: 'Device verification failed.' },
  NONCE_INVALID: { status: 401, message: 'The request expired. Please try again.' },
  CONSENT_REQUIRED: { status: 403, message: 'Please accept the privacy notice first.' },

  OUTSIDE_GEOFENCE: { status: 422, message: 'You are outside your work location.' },
  MOCK_LOCATION: { status: 422, message: 'Turn off fake location apps to punch.' },
  LOW_ACCURACY: { status: 422, message: 'Location is not accurate enough. Move to an open area and retry.' },
  NON_WORKING_DAY: { status: 422, message: 'Punching is closed today (holiday or weekly off).' },
  ON_LEAVE: { status: 422, message: 'You are on approved leave today.' },
  LIVENESS_INVALID: { status: 422, message: 'Face check failed. Please try again.' },
  SELFIE_MISSING: { status: 422, message: 'Selfie upload did not complete. Please try again.' },
  PUNCH_TOO_SOON: { status: 429, message: 'You punched a moment ago. Please wait.' },
  NO_SITES: { status: 422, message: 'No work location is assigned to you. Contact your employer.' },
  INTENT_EXPIRED: { status: 410, message: 'The punch took too long. Please start again.' },
  PUNCH_LIMIT: { status: 429, message: 'You have reached today’s punch limit. Contact your employer.' },

  REGULARIZATION_UNAVAILABLE: { status: 409, message: 'There is no time outside working hours to ask about for this day.' },
  REGULARIZATION_EXISTS: { status: 409, message: 'You have already asked about this day.' },

  PERIOD_LOCKED: { status: 409, message: 'This pay month is locked.' },
  LEAVE_OVERLAP: { status: 409, message: 'You already have leave on these dates.' },
  LEAVE_INSUFFICIENT_BALANCE: { status: 422, message: 'Not enough leave balance.' },
  LEAVE_BACKDATE_LIMIT: { status: 422, message: 'Leave cannot be applied this far back.' },
  LAST_ADMIN: { status: 409, message: 'At least one active Admin is required.' },
  IMPORT_INVALID: { status: 422, message: 'The uploaded file has errors.' },
} as const satisfies Record<string, { status: number; message: string }>;

export type ErrorCode = keyof typeof ERROR_CODES;

export interface ApiErrorBody {
  readonly code: ErrorCode;
  readonly message: string;
  readonly details?: unknown;
}

export interface ApiMeta {
  readonly page?: number;
  readonly pageSize?: number;
  readonly total?: number;
  readonly nextCursor?: string | null;
}

export type ApiEnvelope<T> =
  | { readonly success: true; readonly data: T; readonly error: null; readonly meta?: ApiMeta }
  | { readonly success: false; readonly data: null; readonly error: ApiErrorBody; readonly meta?: ApiMeta };
