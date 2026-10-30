import { describe, expect, it } from 'vitest';
import { manualMarkSchema } from './attendance.js';

const base = { employeeId: '01a18b4c-0000-7000-8000-000000000001', date: '2026-10-30', reason: 'Was on site visit' };

describe('manualMarkSchema', () => {
  it('accepts a Leave mark without a leave type (Leave module off)', () => {
    expect(manualMarkSchema.safeParse({ ...base, status: 'LEAVE' }).success).toBe(true);
  });

  it('still accepts a leave type when one is given', () => {
    expect(manualMarkSchema.safeParse({ ...base, status: 'LEAVE', leaveTypeId: '01a18b4c-0000-7000-8000-000000000002' }).success).toBe(true);
  });
});
