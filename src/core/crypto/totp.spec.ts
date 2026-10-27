import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, totpAt, verifyTotp } from './totp.js';

// RFC 6238 test secret "12345678901234567890" (SHA-1).
const SECRET = base32Encode(Buffer.from('12345678901234567890'));

describe('totp', () => {
  it('round-trips base32', () => {
    expect(base32Decode(base32Encode(Buffer.from('hello world'))).toString()).toBe('hello world');
  });

  it('matches RFC 6238 vectors (last 6 digits)', () => {
    expect(totpAt(SECRET, 59_000)).toBe('287082');
    expect(totpAt(SECRET, 1_111_111_109_000)).toBe('081804');
  });

  it('verifies with ±1 step drift and rejects other codes', () => {
    const now = 1_111_111_109_000;
    expect(verifyTotp(SECRET, totpAt(SECRET, now - 30_000), now)).toBe(true);
    expect(verifyTotp(SECRET, '000000', now)).toBe(false);
    expect(verifyTotp(SECRET, 'abc', now)).toBe(false);
  });
});
