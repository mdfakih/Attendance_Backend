import { Body, type PipeTransform, Query } from '@nestjs/common';
import type { ZodType } from 'zod';

/** Validates and transforms input with a Zod schema; ZodError becomes VALIDATION_FAILED. */
export class ZodPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    return this.schema.parse(value ?? {});
  }
}

export const ZBody = <T>(schema: ZodType<T>): ParameterDecorator => Body(new ZodPipe(schema));
export const ZQuery = <T>(schema: ZodType<T>): ParameterDecorator => Query(new ZodPipe(schema));
