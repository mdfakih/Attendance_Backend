/**
 * Development/bootstrap seed: superadmin from env, a default plan and the platform's
 * default employee privacy notice. Idempotent.
 */
import { existsSync } from 'node:fs';
import { hash } from '@node-rs/argon2';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';

if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

const NOTICE_BODY = `**How we use your data**

Your employer uses this app to record attendance. When you punch in or out we collect:

- a selfie taken in the app, to confirm it is you;
- your location at that moment, to confirm you are at your work site;
- the time, and basic details of this phone.

We do **not** track your location at any other time.

Your employer uses this data for attendance and pay. Selfies are deleted automatically after the retention period your employer sets. You can ask your employer to access, correct or delete your data at any time.`;

async function main(): Promise<void> {
  const url = process.env['DATABASE_URL'];
  const email = process.env['SEED_SUPERADMIN_EMAIL'];
  const password = process.env['SEED_SUPERADMIN_PASSWORD'];
  if (!url || !email || !password) {
    throw new Error('DATABASE_URL, SEED_SUPERADMIN_EMAIL and SEED_SUPERADMIN_PASSWORD are required');
  }
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  try {
    await prisma.platformUser.upsert({
      where: { email },
      update: {},
      create: {
        email,
        fullName: 'Platform Superadmin',
        role: 'SUPERADMIN',
        passwordHash: await hash(password, { memoryCost: 19456, timeCost: 2, parallelism: 1 }),
      },
    });
    await prisma.plan.upsert({
      where: { code_version: { code: 'STANDARD', version: 1 } },
      update: {},
      create: { code: 'STANDARD', name: 'Standard', pricePerEmployee: 49, minBillableEmployees: 10, trialDays: 14 },
    });
    const notice = await prisma.consentNotice.findFirst({ where: { tenantId: null, audience: 'EMPLOYEE', version: 1 } });
    if (!notice) {
      await prisma.consentNotice.create({
        data: {
          audience: 'EMPLOYEE',
          version: 1,
          title: 'Privacy notice',
          bodyMd: NOTICE_BODY,
          purposes: [
            { code: 'ATTENDANCE_SELFIE', label: 'Selfie at punch to verify identity', required: true },
            { code: 'ATTENDANCE_LOCATION', label: 'Location at punch to verify work site', required: true },
            { code: 'PAY', label: 'Use attendance to calculate pay', required: true },
          ],
          publishedAt: new Date(),
        },
      });
    }
    process.stdout.write(`Seeded superadmin ${email}, plan STANDARD and the employee privacy notice.\n`);
  } finally {
    await prisma.$disconnect();
  }
}

await main();
