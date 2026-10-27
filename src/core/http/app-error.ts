import { ERROR_CODES, type ErrorCode } from '@attendance/contracts';

/** Domain error carrying a stable code from the contracts catalogue. */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, message?: string, details?: unknown) {
    super(message ?? ERROR_CODES[code].message);
    this.name = 'AppError';
    this.code = code;
    this.status = ERROR_CODES[code].status;
    this.details = details;
  }
}

export function notFound(entity = 'Record'): AppError {
  return new AppError('NOT_FOUND', `${entity} not found.`);
}
