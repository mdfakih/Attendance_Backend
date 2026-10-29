import { describe, expect, it } from 'vitest';
import { isUniqueViolation, retryOnUniqueViolation } from './unique-retry.js';

const conflict = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });

describe('retryOnUniqueViolation', () => {
  it('returns the first result when there is no conflict', async () => {
    await expect(retryOnUniqueViolation(async () => 'ok')).resolves.toBe('ok');
  });

  it('retries once after a unique violation', async () => {
    let calls = 0;
    const result = await retryOnUniqueViolation(async () => {
      calls += 1;
      if (calls === 1) throw conflict;
      return 'second';
    });
    expect(result).toBe('second');
    expect(calls).toBe(2);
  });

  it('rethrows other errors without retrying', async () => {
    let calls = 0;
    await expect(
      retryOnUniqueViolation(async () => {
        calls += 1;
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(calls).toBe(1);
  });

  it('recognises only P2002', () => {
    expect(isUniqueViolation(conflict)).toBe(true);
    expect(isUniqueViolation(new Error('x'))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
  });
});
