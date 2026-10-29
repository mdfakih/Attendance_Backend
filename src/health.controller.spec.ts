import { describe, expect, it } from 'vitest';
import { probe } from './health.controller.js';

describe('probe', () => {
  it('reports up when the check resolves in time', async () => {
    await expect(probe(async () => 'PONG', 50)).resolves.toBe('up');
  });

  it('reports down when the check fails', async () => {
    await expect(probe(async () => Promise.reject(new Error('refused')), 50)).resolves.toBe('down');
  });

  it('reports down when the check hangs past the timeout', async () => {
    await expect(probe(() => new Promise(() => undefined), 20)).resolves.toBe('down');
  });
});
