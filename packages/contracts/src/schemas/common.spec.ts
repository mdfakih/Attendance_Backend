import { describe, expect, it } from 'vitest';
import { activationCodeSchema } from './auth.js';
import { moneySchema, normalizeIndianPhone, phoneSchema } from './common.js';
import { resolveFeatures } from '../features.js';

describe('normalizeIndianPhone', () => {
  it.each([
    ['9876543210', '+919876543210'],
    ['+91 98765 43210', '+919876543210'],
    ['091-9876543210', null],
    ['09876543210', '+919876543210'],
    ['919876543210', '+919876543210'],
    ['5876543210', null],
    ['98765', null],
  ])('normalises %s → %s', (input, expected) => {
    expect(normalizeIndianPhone(input)).toBe(expected);
  });

  it('phoneSchema rejects invalid numbers with a message', () => {
    const result = phoneSchema.safeParse('12345');
    expect(result.success).toBe(false);
  });
});

describe('activationCodeSchema', () => {
  it('accepts lowercase and dashed input', () => {
    expect(activationCodeSchema.parse('abcd-efgh')).toBe('ABCDEFGH');
  });

  it('rejects ambiguous characters', () => {
    expect(activationCodeSchema.safeParse('ABCD0FGH').success).toBe(false);
    expect(activationCodeSchema.safeParse('ABCDIFGH').success).toBe(false);
  });
});

describe('moneySchema', () => {
  it('accepts numbers and strings with up to 2 decimals', () => {
    expect(moneySchema.parse(25000)).toBe('25000');
    expect(moneySchema.parse('1250.5')).toBe('1250.5');
  });

  it('rejects negatives and 3 decimals', () => {
    expect(moneySchema.safeParse('-1').success).toBe(false);
    expect(moneySchema.safeParse('1.234').success).toBe(false);
  });
});

describe('resolveFeatures', () => {
  it('uses registry defaults when no rows exist', () => {
    const state = resolveFeatures([]);
    expect(state.LEAVE).toBe(false);
    expect(state.DEVICE_APPROVAL).toBe(false);
  });

  it('applies explicit rows', () => {
    const state = resolveFeatures([{ key: 'LEAVE', enabled: true }]);
    expect(state.LEAVE).toBe(true);
  });
});
