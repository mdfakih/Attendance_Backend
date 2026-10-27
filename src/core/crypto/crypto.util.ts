import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPublicKey,
  randomBytes,
  randomInt,
  timingSafeEqual,
  verify,
} from 'node:crypto';

/** 32 symbols without look-alikes (no 0/O, 1/I). 8 chars ≈ 40 bits. */
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 8;

export function generateActivationCode(): string {
  return Array.from({ length: CODE_LENGTH }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
}

export function formatCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export function hmacHex(key: string, data: string): string {
  return createHmac('sha256', key).update(data).digest('hex');
}

export function safeEqualHex(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  if (left.length !== right.length || left.length === 0) {
    return false;
  }
  return timingSafeEqual(left, right);
}

/** Opaque URL-safe random token (refresh tokens, invitation links, nonces). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

const GCM_VERSION = 'v1';

/** AES-256-GCM. Output: `v1.<iv>.<tag>.<ciphertext>` (base64url parts). */
export function encryptString(keyBase64: string, plaintext: string): string {
  const key = Buffer.from(keyBase64, 'base64');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [GCM_VERSION, iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
}

export function decryptString(keyBase64: string, payload: string): string {
  const [version, iv, tag, ciphertext] = payload.split('.');
  if (version !== GCM_VERSION || !iv || !tag || !ciphertext) {
    throw new Error('Unsupported ciphertext format');
  }
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(keyBase64, 'base64'), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
}

/**
 * Verifies an ES256 (P-256 + SHA-256) signature produced by the device key.
 * Accepts DER or raw (r||s, 64 bytes) signature encodings.
 */
export function verifyDeviceSignature(publicKeySpkiBase64: string, message: string, signatureBase64: string): boolean {
  try {
    const key = createPublicKey({ key: Buffer.from(publicKeySpkiBase64, 'base64'), format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
      return false;
    }
    const signature = Buffer.from(signatureBase64, 'base64');
    const dsaEncoding = signature.length === 64 ? 'ieee-p1363' : 'der';
    return verify('sha256', Buffer.from(message, 'utf8'), { key, dsaEncoding }, signature);
  } catch {
    return false;
  }
}

/** Fingerprint of a public key for indexing and display. */
export function keyFingerprint(publicKeySpkiBase64: string): string {
  return sha256Hex(Buffer.from(publicKeySpkiBase64, 'base64'));
}

/** Validates that the base64 string is a P-256 SPKI public key. */
export function isP256PublicKey(publicKeySpkiBase64: string): boolean {
  try {
    const key = createPublicKey({ key: Buffer.from(publicKeySpkiBase64, 'base64'), format: 'der', type: 'spki' });
    return key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1';
  } catch {
    return false;
  }
}
