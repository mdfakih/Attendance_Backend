import { describe, expect, it } from 'vitest';
import { roleSchema } from './tenant.js';

describe('roleSchema', () => {
  it('accepts a matrix that lists only some modules', () => {
    const parsed = roleSchema.parse({ name: 'Supervisor', permissions: { DASHBOARD: ['view'], ATTENDANCE: ['view', 'export'] } });
    expect(parsed.permissions).toEqual({ DASHBOARD: ['view'], ATTENDANCE: ['view', 'export'] });
  });

  it('accepts a role with no permissions yet', () => {
    expect(roleSchema.safeParse({ name: 'Viewer', permissions: {} }).success).toBe(true);
  });

  it('rejects unknown modules and actions', () => {
    expect(roleSchema.safeParse({ name: 'Bad', permissions: { BILLING: ['view'] } }).success).toBe(false);
    expect(roleSchema.safeParse({ name: 'Bad', permissions: { DASHBOARD: ['approve'] } }).success).toBe(false);
  });
});
