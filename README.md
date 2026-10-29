# Attendance Backend

NestJS 12 + Prisma 7 + PostgreSQL API for the attendance & pay-monitoring SaaS. One process, no background worker and no cron jobs (see [How work happens without a worker](#how-work-happens-without-a-worker)). Design docs live in [`docs/`](docs/): [PRD](docs/prd.md), [architecture](docs/architecture.md), [database schema](docs/database-schema.md), [implementation plan](docs/implementation-plan.md), [task list](docs/task-list.md), [cost estimate](docs/cost-estimate.md).

`packages/contracts` holds the enums, error codes, permission catalogue, feature registry and Zod schemas shared with the web app ([Attendance](https://github.com/mdfakih/Attendance) syncs a copy with `npm run sync:contracts`).

## Run locally

Requirements: Node 24+, Docker Desktop (for Valkey, object storage and the mail catcher). Postgres is Neon (or any Postgres via `DATABASE_URL`).

```bash
# 1. Infra: Valkey (Redis), RustFS (S3-compatible, :9000 / console :9001), Mailpit (:8025)
cp infra/.env.example infra/.env      # set passwords
npm run dev:infra

# 2. App config
cp .env.example .env                  # fill DATABASE_URL (+ DATABASE_URL_UNPOOLED for Neon), secrets, S3 keys from infra/.env
npm install

# 3. Database
npm run db:deploy                     # apply migrations
npm run db:seed                       # superadmin + default plan + privacy notice

# 4. API
npm run build
npm run start:prod                    # API on :4000
```

Health: `GET /health/ready`. Superadmin login: `POST /v1/platform/auth/login` with `SEED_SUPERADMIN_EMAIL` / `SEED_SUPERADMIN_PASSWORD`.

End-to-end smoke test against a running API: `node scripts/smoke.mjs <superadminEmail> <password>`.

## How work happens without a worker

| Work | Where it happens |
|---|---|
| Absent days, closing a day after its shift window, days flagged by shift/holiday/policy changes | Recomputed right before they are read (`AttendanceSettleService`): dashboard, daily list, register, calendars, pay, exports |
| Pay summaries | Flagged stale on attendance/salary changes; recomputed on their next read |
| Emails and pushes | Sent inline; failures are logged and never fail the request |
| Exports | Generated inside the request |
| Selfie purge, leave accrual, usage snapshot, billing status, code expiry | `HousekeepingService`: the first dashboard or app request of a tenant's day claims the day and runs these after the response |
| "Forgot to punch out?" reminder | Scheduled on the phone from `reminderAt` in the punch response |

Files live in Neon Object Storage (bucket `attendance`, declared in `neon.ts`; `neon deploy` creates it). Neon stores lifecycle rules but does not enforce them, so selfie retention relies on the daily housekeeping, and selfies past retention are hidden on read.

## Working hours and regularization

Working hours come from the employee's shift assignment, else the branch default shift, else the company default shift (`tenant_settings.default_shift_id`). Punch time outside those hours is recorded but not counted. Outside time below the policy's `outsideMinMinutes` (default 15) on either side is ignored. The employee asks for the rest to be counted (`POST /v1/mobile/regularizations`, with a reason); an employer approves all or part of it (`POST /v1/tenant/attendance/regularizations/:id/decision`). Approved time first fills the day up to full duty; only the remainder becomes overtime, and only when the OVERTIME feature is on. A policy with `otRequiresApproval: false` counts outside time automatically.

## Deploying to Vercel

`src/main.ts` is detected as a NestJS app and runs as one Vercel Function in `sin1` (next to Neon in Singapore, see `vercel.json`). The build runs `prisma generate`. Set the environment variables from `.env.example`, using Neon's pooled URL for `DATABASE_URL`, a hosted Redis for `REDIS_URL` (`rediss://` works), and Neon Object Storage (or any S3-compatible store). Run `npm run db:deploy` against the direct Neon URL before the first deployment. The Hobby plan is for non-commercial use only.

## Layout

```
src/core        config, request context, Prisma + tenant-scoping extension, auth guards, crypto, storage, notify, background helper
src/engines     pure, tested calculation engines: attendance day, shift attribution, geofence, leave days, earned pay
src/modules     platform (superadmin), tenant-auth, company, org, time, employees, attendance, mobile, leave, pay, dashboard, exports, housekeeping
prisma/schema   multi-file Prisma schema; prisma/migrations
```

## Tests

`npm test` runs unit tests (engines, settle planning, crypto, tenant scoping). `npm run typecheck` for types.
