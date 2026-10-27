import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { ERROR_CODES, type ErrorCode } from '@attendance/contracts';
import type { Response } from 'express';
import { ZodError } from 'zod';
import { Prisma } from '../../generated/prisma/client.js';
import { currentContext } from '../context/request-context.js';
import { AppError } from './app-error.js';

interface ErrorPayload {
  readonly status: number;
  readonly code: ErrorCode;
  readonly message: string;
  readonly details?: unknown;
}

const HTTP_STATUS_CODES: Readonly<Record<number, ErrorCode>> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  413: 'BAD_REQUEST',
  429: 'RATE_LIMITED',
};

function fromCode(code: ErrorCode, message?: string, details?: unknown): ErrorPayload {
  return { status: ERROR_CODES[code].status, code, message: message ?? ERROR_CODES[code].message, details };
}

export function toErrorPayload(exception: unknown): ErrorPayload {
  if (exception instanceof AppError) {
    return { status: exception.status, code: exception.code, message: exception.message, details: exception.details };
  }
  if (exception instanceof ZodError) {
    const details = exception.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    return fromCode('VALIDATION_FAILED', undefined, details);
  }
  if (exception instanceof Prisma.PrismaClientKnownRequestError) {
    if (exception.code === 'P2002') return fromCode('CONFLICT');
    if (exception.code === 'P2025') return fromCode('NOT_FOUND');
    if (exception.code === 'P2003') return fromCode('BAD_REQUEST', 'A referenced record does not exist.');
  }
  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    const code = HTTP_STATUS_CODES[status] ?? (status >= 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST');
    return { status, code, message: status >= 500 ? ERROR_CODES.INTERNAL_ERROR.message : exception.message };
  }
  return fromCode('INTERNAL_ERROR');
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('HTTP');

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const payload = toErrorPayload(exception);
    if (payload.status >= 500) {
      const requestId = currentContext()?.requestId;
      this.logger.error({ requestId, err: exception }, exception instanceof Error ? exception.stack : String(exception));
    }
    if (response.headersSent) {
      return;
    }
    response.status(payload.status).json({
      success: false,
      data: null,
      error: { code: payload.code, message: payload.message, ...(payload.details ? { details: payload.details } : {}) },
    });
  }
}
