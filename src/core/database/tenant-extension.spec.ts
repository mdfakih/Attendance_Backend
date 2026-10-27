import { describe, expect, it } from 'vitest';
import { GLOBAL_MODELS, scopeArgs } from './tenant-extension.js';

const TID = '0190f3c4-0000-7000-8000-000000000001';

describe('scopeArgs', () => {
  it('adds tenantId to where for reads, updates and deletes', () => {
    for (const op of ['findMany', 'findFirst', 'findUnique', 'count', 'update', 'updateMany', 'delete', 'deleteMany']) {
      expect(scopeArgs(op, { where: { id: 'x' } }, TID)).toEqual({ where: { id: 'x', tenantId: TID } });
    }
  });

  it('adds where even when args are missing', () => {
    expect(scopeArgs('findMany', undefined, TID)).toEqual({ where: { tenantId: TID } });
  });

  it('overrides a tenantId supplied by the caller', () => {
    const scoped = scopeArgs('findMany', { where: { tenantId: 'other' } }, TID);
    expect(scoped).toEqual({ where: { tenantId: TID } });
  });

  it('injects tenantId into create data, including createMany arrays', () => {
    expect(scopeArgs('create', { data: { name: 'a' } }, TID)).toEqual({ data: { name: 'a', tenantId: TID } });
    expect(scopeArgs('createMany', { data: [{ n: 1 }, { n: 2 }] }, TID)).toEqual({
      data: [
        { n: 1, tenantId: TID },
        { n: 2, tenantId: TID },
      ],
    });
  });

  it('scopes upsert where and create', () => {
    const scoped = scopeArgs('upsert', { where: { id: 'x' }, create: { a: 1 }, update: { a: 2 } }, TID);
    expect(scoped).toEqual({ where: { id: 'x', tenantId: TID }, create: { a: 1, tenantId: TID }, update: { a: 2 } });
  });

  it('does not mutate the input args', () => {
    const args = { where: { id: 'x' } };
    scopeArgs('findMany', args, TID);
    expect(args).toEqual({ where: { id: 'x' } });
  });

  it('keeps tenant tables out of the global list', () => {
    expect(GLOBAL_MODELS.has('Employee')).toBe(false);
    expect(GLOBAL_MODELS.has('Punch')).toBe(false);
    expect(GLOBAL_MODELS.has('Tenant')).toBe(true);
  });
});
