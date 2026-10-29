import { describe, expect, it } from 'vitest';
import { loadEnv } from './env.js';

const secret = 'x'.repeat(40);
const base = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  S3_BUCKET: 'attendance',
  JWT_SECRET_EMPLOYEE: secret,
  JWT_SECRET_TENANT: secret,
  JWT_SECRET_PLATFORM: secret,
  CODE_PEPPER_V1: secret,
  CODE_ENC_KEY: Buffer.alloc(32, 1).toString('base64'),
  DEVICE_ID_HMAC_KEY: secret,
};

describe('loadEnv storage settings', () => {
  it("accepts Neon's AWS_* storage variables when S3_* are absent", () => {
    const env = loadEnv({
      ...base,
      AWS_ENDPOINT_URL_S3: 'https://br-x.storage.c-4.ap-southeast-1.aws.neon.tech',
      AWS_ACCESS_KEY_ID: 'nak_live_key',
      AWS_SECRET_ACCESS_KEY: 'secret-value',
      AWS_REGION: 'ap-southeast-1',
    });
    expect(env.S3_ENDPOINT).toBe('https://br-x.storage.c-4.ap-southeast-1.aws.neon.tech');
    expect(env.S3_ACCESS_KEY).toBe('nak_live_key');
    expect(env.S3_SECRET_KEY).toBe('secret-value');
    expect(env.S3_REGION).toBe('ap-southeast-1');
  });

  it('prefers the S3_* variables when both are set', () => {
    const env = loadEnv({
      ...base,
      S3_ACCESS_KEY: 's3-key',
      S3_SECRET_KEY: 's3-secret',
      AWS_ACCESS_KEY_ID: 'aws-key',
      AWS_SECRET_ACCESS_KEY: 'aws-secret',
    });
    expect(env.S3_ACCESS_KEY).toBe('s3-key');
    expect(env.S3_SECRET_KEY).toBe('s3-secret');
  });

  it('still lists the storage keys when neither name is set', () => {
    expect(() => loadEnv(base)).toThrow(/S3_ACCESS_KEY/);
  });
});
