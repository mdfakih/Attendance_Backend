import type { ApiMeta } from '@attendance/contracts';

const PAGED = Symbol('paged');

export interface Paged<T> {
  readonly [PAGED]: true;
  readonly items: readonly T[];
  readonly meta: ApiMeta;
}

/** Return from a handler to emit `data: items` plus `meta` in the envelope. */
export function paged<T>(items: readonly T[], meta: ApiMeta): Paged<T> {
  return { [PAGED]: true, items, meta };
}

export function isPaged(value: unknown): value is Paged<unknown> {
  return typeof value === 'object' && value !== null && PAGED in value;
}

export interface PageArgs {
  readonly skip: number;
  readonly take: number;
}

export function pageArgs(page: number, pageSize: number): PageArgs {
  return { skip: (page - 1) * pageSize, take: pageSize };
}
