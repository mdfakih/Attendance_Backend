import { z } from 'zod';

const secret = (name: string) => z.string().min(32, `${name} must be at least 32 characters`);

const base64Key32 = z.string().refine((v) => {
  try {
    return Buffer.from(v, 'base64').length === 32;
  } catch {
    return false;
  }
}, 'must be base64 of exactly 32 bytes');

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  DATABASE_URL: z.string().startsWith('postgres'),
  REDIS_URL: z.string().startsWith('redis'),

  S3_ENDPOINT: z.url().optional(),
  /** Endpoint used in presigned URLs handed to browsers/phones (e.g. LAN IP in development). */
  S3_PUBLIC_ENDPOINT: z.url().optional(),
  S3_REGION: z.string().default('ap-south-1'),
  S3_ACCESS_KEY: z.string().min(3),
  S3_SECRET_KEY: z.string().min(8),
  S3_BUCKET: z.string().min(3),
  S3_FORCE_PATH_STYLE: z.stringbool().default(false),

  SMTP_HOST: z.string().default('localhost'),
  SMTP_PORT: z.coerce.number().int().default(1025),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_FROM: z.string().default('Attendance <no-reply@attendance.local>'),

  JWT_SECRET_EMPLOYEE: secret('JWT_SECRET_EMPLOYEE'),
  JWT_SECRET_TENANT: secret('JWT_SECRET_TENANT'),
  JWT_SECRET_PLATFORM: secret('JWT_SECRET_PLATFORM'),

  CODE_PEPPER_V1: secret('CODE_PEPPER_V1'),
  CODE_ENC_KEY: base64Key32,
  DEVICE_ID_HMAC_KEY: secret('DEVICE_ID_HMAC_KEY'),

  WEB_APP_URL: z.url().default('http://localhost:3000'),
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:3000')
    .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean)),

  FCM_SERVICE_ACCOUNT_PATH: z.string().optional().transform((v) => (v ? v : undefined)),
  /** The service-account JSON itself, for hosts without a file system (e.g. Vercel). Wins over the path. */
  FCM_SERVICE_ACCOUNT_JSON: z.string().optional().transform((v) => (v ? v : undefined)),

  SEED_SUPERADMIN_EMAIL: z.email().optional(),
  SEED_SUPERADMIN_PASSWORD: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

export const ENV = Symbol('ENV');

/** Parses the environment and fails fast with every missing/invalid variable listed. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }
  return result.data;
}
