# Attendance Backend

NestJS 12 + Prisma 7 + PostgreSQL API and background worker for the attendance & pay-monitoring SaaS. Design docs live in [`docs/`](docs/): [PRD](docs/prd.md), [architecture](docs/architecture.md), [database schema](docs/database-schema.md), [implementation plan](docs/implementation-plan.md), [task list](docs/task-list.md), [cost estimate](docs/cost-estimate.md).

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

# 4. Processes
npm run build
npm run start:prod                    # API on :4000
npm run start:worker                  # queues + schedulers (separate terminal)
```

Health: `GET /health/ready`. Superadmin login: `POST /v1/platform/auth/login` with `SEED_SUPERADMIN_EMAIL` / `SEED_SUPERADMIN_PASSWORD`.

End-to-end smoke test against a running API: `node scripts/smoke.mjs <superadminEmail> <password>`.

## Layout

```
src/core        config, request context, Prisma + tenant-scoping extension, auth guards, crypto, storage, queues, notify
src/engines     pure, tested calculation engines: attendance day, shift attribution, geofence, leave days, earned pay
src/modules     platform (superadmin), tenant-auth, company, org, time, employees, attendance, mobile, leave, pay, dashboard, exports
src/worker      BullMQ processors + schedulers (worker.ts entry point)
prisma/schema   multi-file Prisma schema; prisma/migrations
```

## Tests

`npm test` runs unit tests (engines, crypto, tenant scoping). `npm run typecheck` for types.
