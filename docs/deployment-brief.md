# Deployment brief — Attendance backend on AWS

For: DevOps engineer setting up hosting. Repo: https://github.com/mdfakih/Attendance_Backend

## What it is

A multi-tenant B2B SaaS backend (Node.js 24 / TypeScript / NestJS 12). Employees punch attendance from an Android app (selfie + GPS); employers use a web dashboard (Next.js, hosted separately on Vercel). The backend is **one stateless process** with no background worker and no cron jobs; it can also run serverless (Vercel, see the README):

| Process | Command | Role |
|---|---|---|
| API | `node dist/main.js` | REST API on `PORT` (default 4000). Health: `GET /health/live`, `GET /health/ready` |

Build: `npm ci && npm run build` (generates the Prisma client, builds `packages/contracts`, then `nest build`). Migrations: `npx prisma migrate deploy` (run once per release, before starting the API). Seed (first time only): `npx prisma db seed`.

## External services it needs

| Service | Requirement | Current / suggested |
|---|---|---|
| PostgreSQL 15+ | `DATABASE_URL` (pooled) + `DATABASE_URL_UNPOOLED` (direct, for migrations) | **Already on Neon** (ap-southeast-1). No RDS needed |
| Redis 7+ / Valkey | `REDIS_URL`; holds caches, rate limits and short-lived punch steps (no queues) | Valkey container on the same host, ElastiCache, or a hosted Redis (`rediss://`) |
| S3-compatible object storage | Private bucket; presigned PUT/GET from phones and browsers → bucket CORS must allow `PUT`/`GET` from `*` (or the app/web origins) with `Content-Type`, `Content-Length` headers | S3 bucket in ap-south-1 + IAM user scoped to that bucket |
| SMTP | Invitation/activation emails | SES (ap-south-1) or any SMTP |
| HTTPS endpoint | Public hostname, TLS required (Android app blocks cleartext) | e.g. `api.<domain>` |
| Firebase (optional) | Service-account JSON path for push notifications | Can be added later |

## Environment variables

Copy `.env.example` → provide via SSM Parameter Store / Secrets Manager / `.env` on host. Required:

```
NODE_ENV=production
PORT=4000
DATABASE_URL=postgresql://...            # Neon pooled
DATABASE_URL_UNPOOLED=postgresql://...   # Neon direct (migrations)
REDIS_URL=redis://:password@host:6379
S3_ENDPOINT=https://s3.ap-south-1.amazonaws.com   # omit for AWS S3 if using default
S3_PUBLIC_ENDPOINT=                      # only if different from S3_ENDPOINT
S3_REGION=ap-south-1
S3_ACCESS_KEY=...
S3_SECRET_KEY=...
S3_BUCKET=...
S3_FORCE_PATH_STYLE=false
SMTP_HOST=email-smtp.ap-south-1.amazonaws.com
SMTP_PORT=587
SMTP_USER=...
SMTP_PASSWORD=...
SMTP_FROM="KamaiGo <no-reply@<domain>>"
JWT_SECRET_EMPLOYEE=<48+ random bytes base64url>
JWT_SECRET_TENANT=<...>
JWT_SECRET_PLATFORM=<...>
CODE_PEPPER_V1=<...>
CODE_ENC_KEY=<base64 of exactly 32 random bytes>
DEVICE_ID_HMAC_KEY=<...>
WEB_APP_URL=https://<vercel-domain>
CORS_ORIGINS=https://<vercel-domain>
FCM_SERVICE_ACCOUNT_PATH=                # optional
SEED_SUPERADMIN_EMAIL=...                # seed only
SEED_SUPERADMIN_PASSWORD=...             # seed only
```

The app validates all of these at startup and exits with a list of what is missing.

## Recommended topology (pilot, cheapest)

Single EC2 `t4g.small` (ARM, 2 GB) in ap-south-1, Ubuntu 24.04, Docker Compose with three containers: `api`, `valkey`, `caddy` (TLS termination via Let's Encrypt, reverse proxy to `api:4000`). Elastic IP + DNS `A` record. Security group: 80, 443 public; 22 restricted. Backups: Neon handles the DB; S3 holds files; Valkey holds only caches and short-lived punch steps, so it needs no backup.

A `Dockerfile`, `docker-compose.prod.yml` and `deploy/setup.sh` are provided in the repo for this topology.

## Alternative topology (managed)

ECS Fargate: one service (API with ALB + target group health check on `/health/ready`), ElastiCache Redis, S3, Secrets Manager for env. Roughly 4–6× the cost of the single instance; same code, no changes.

## Operational notes

- Deploy order: build image → `prisma migrate deploy` → restart API.
- Logs are JSON to stdout (ship to CloudWatch). PII fields are redacted.
- Rate limiting and CSRF are in the app; a WAF is optional.
- Time is stored in UTC; tenants display in Asia/Kolkata.
- Retention: selfies older than the tenant's period (default 90 days) are hidden on read and deleted by the once-a-day housekeeping that the tenant's first request of the day triggers. On AWS S3, add a lifecycle expiration rule per tenant prefix `t/<tenantId>/selfies/` as a backstop for tenants with no activity. Neon Object Storage stores lifecycle rules but does not enforce them.
- Scaling: API is stateless (run N copies); the daily housekeeping is claimed atomically in Postgres, so it runs once per tenant per day.
