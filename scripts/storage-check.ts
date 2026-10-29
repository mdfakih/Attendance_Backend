// Checks the configured object storage end to end with the app's own StorageService:
// server write → presigned PUT (as the phone uploads a selfie) → HEAD → presigned GET → delete.
// Usage: npm run storage:check   (reads .env; needs S3_* or Neon's AWS_* storage variables)
import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { loadEnv } from '../src/core/config/env.js';
import { StorageService } from '../src/core/storage/storage.service.js';

if (existsSync('.env')) process.loadEnvFile('.env');

const env = loadEnv();
const storage = new StorageService(env);
const prefix = `healthcheck/${randomUUID()}`;
let failed = false;

async function step(name: string, run: () => Promise<string>): Promise<void> {
  try {
    console.log(`ok    ${name}: ${await run()}`);
  } catch (error: unknown) {
    failed = true;
    console.log(`FAIL  ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

console.log(`Bucket "${storage.bucket}" at ${env.S3_ENDPOINT ?? 'AWS default endpoint'} (path-style: ${env.S3_FORCE_PATH_STYLE})`);

const serverKey = `${prefix}/server.txt`;
await step('server upload', async () => {
  await storage.put(serverKey, Buffer.from('attendance storage check'), 'text/plain');
  return serverKey;
});

const selfieKey = `${prefix}/selfie.jpg`;
const selfie = randomBytes(12_000);
await step('presigned upload (phone)', async () => {
  const upload = await storage.presignPut(selfieKey, 'image/jpeg', selfie.length);
  const res = await fetch(upload.url, { method: upload.method, headers: upload.headers, body: selfie });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text()}`);
  return `HTTP ${res.status}`;
});

await step('head (commit check)', async () => {
  const info = await storage.head(selfieKey);
  if (!info) throw new Error('object not found');
  if (info.sizeBytes !== selfie.length) throw new Error(`size ${info.sizeBytes}, expected ${selfie.length}`);
  return `${info.sizeBytes} bytes, ${info.contentType ?? 'no type'}`;
});

await step('presigned view (dashboard)', async () => {
  const res = await fetch(await storage.presignGet(selfieKey, 60));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = Buffer.from(await res.arrayBuffer());
  if (!body.equals(selfie)) throw new Error('downloaded bytes differ');
  return `HTTP ${res.status}, bytes match`;
});

await step('delete (selfie purge)', async () => {
  await storage.deleteMany([serverKey, selfieKey]);
  if (await storage.head(selfieKey)) throw new Error('object still present');
  return 'removed';
});

console.log(failed ? 'Storage check FAILED' : 'Storage check passed');
process.exit(failed ? 1 : 0);
