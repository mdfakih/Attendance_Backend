import { type CallHandler, type ExecutionContext, Injectable, type NestInterceptor, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { map, type Observable } from 'rxjs';
import { isPaged } from './envelope.js';

const RAW_RESPONSE = 'raw_response';

/** Skip the JSON envelope (file downloads, streams, redirects). */
export const RawResponse = (): MethodDecorator => SetMetadata(RAW_RESPONSE, true);

@Injectable()
export class EnvelopeInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const raw = this.reflector.getAllAndOverride<boolean>(RAW_RESPONSE, [context.getHandler(), context.getClass()]);
    if (raw || context.getType() !== 'http') {
      return next.handle();
    }
    return next.handle().pipe(
      map((value: unknown) =>
        isPaged(value)
          ? { success: true, data: value.items, error: null, meta: value.meta }
          : { success: true, data: value ?? null, error: null },
      ),
    );
  }
}
