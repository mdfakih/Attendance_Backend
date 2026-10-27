import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { runWithContext, SYSTEM_ACTOR } from './request-context.js';

const REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;

/** Opens the per-request async context; guards fill in the authenticated principal later. */
export function contextMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header('x-request-id');
  const requestId = incoming && REQUEST_ID.test(incoming) ? incoming : randomUUID();
  res.setHeader('x-request-id', requestId);
  runWithContext(
    {
      requestId,
      ip: req.ip,
      userAgent: req.header('user-agent'),
      actor: { ...SYSTEM_ACTOR, type: 'SYSTEM', name: 'anonymous' },
    },
    next,
  );
}
