import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CODE_ALPHABET,
  decryptString,
  encryptString,
  formatCode,
  generateActivationCode,
  hmacHex,
  isP256PublicKey,
  safeEqualHex,
  verifyDeviceSignature,
} from './crypto.util.js';

function deviceKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  return { spki, privateKey };
}

describe('activation codes', () => {
  it('generates 8 characters from the unambiguous alphabet', () => {
    for (let i = 0; i < 200; i += 1) {
      const code = generateActivationCode();
      expect(code).toHaveLength(8);
      expect([...code].every((c) => CODE_ALPHABET.includes(c))).toBe(true);
    }
  });

  it('formats as XXXX-XXXX', () => {
    expect(formatCode('ABCDEFGH')).toBe('ABCD-EFGH');
  });
});

describe('hmac + safe compare', () => {
  it('matches equal digests and rejects different ones', () => {
    const a = hmacHex('k'.repeat(32), 'data');
    expect(safeEqualHex(a, hmacHex('k'.repeat(32), 'data'))).toBe(true);
    expect(safeEqualHex(a, hmacHex('k'.repeat(32), 'other'))).toBe(false);
    expect(safeEqualHex(a, '')).toBe(false);
  });
});

describe('AES-GCM', () => {
  const key = randomBytes(32).toString('base64');

  it('round-trips plaintext', () => {
    expect(decryptString(key, encryptString(key, 'ABCDEFGH'))).toBe('ABCDEFGH');
  });

  it('fails on tampered ciphertext', () => {
    const payload = encryptString(key, 'secret');
    const tampered = payload.slice(0, -2) + (payload.endsWith('A') ? 'B' : 'A') + payload.slice(-1);
    expect(() => decryptString(key, tampered)).toThrow();
  });
});

describe('verifyDeviceSignature', () => {
  it('accepts a DER signature from the matching P-256 key', () => {
    const { spki, privateKey } = deviceKey();
    const sig = sign('sha256', Buffer.from('v1|ACTIVATE|n|p'), privateKey).toString('base64');
    expect(isP256PublicKey(spki)).toBe(true);
    expect(verifyDeviceSignature(spki, 'v1|ACTIVATE|n|p', sig)).toBe(true);
  });

  it('accepts a raw r||s signature', () => {
    const { spki, privateKey } = deviceKey();
    const sig = sign('sha256', Buffer.from('msg'), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64');
    expect(verifyDeviceSignature(spki, 'msg', sig)).toBe(true);
  });

  it('rejects a different message or key', () => {
    const { spki, privateKey } = deviceKey();
    const other = deviceKey();
    const sig = sign('sha256', Buffer.from('msg'), privateKey).toString('base64');
    expect(verifyDeviceSignature(spki, 'msg2', sig)).toBe(false);
    expect(verifyDeviceSignature(other.spki, 'msg', sig)).toBe(false);
    expect(verifyDeviceSignature('not-a-key', 'msg', sig)).toBe(false);
  });
});
