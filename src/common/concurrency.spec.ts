import { describe, expect, it } from 'vitest';
import { forEachLimit } from './concurrency.js';

describe('forEachLimit', () => {
  it('visits every item once and never exceeds the limit', async () => {
    let inFlight = 0;
    let peak = 0;
    const seen: number[] = [];
    await forEachLimit([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      seen.push(n);
      inFlight -= 1;
    });
    expect([...seen].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(peak).toBe(3);
  });

  it('handles an empty list', async () => {
    await expect(forEachLimit([], 4, async () => undefined)).resolves.toBeUndefined();
  });

  it('rejects when a task fails', async () => {
    await expect(
      forEachLimit([1, 2], 2, async (n) => {
        if (n === 2) throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });
});
