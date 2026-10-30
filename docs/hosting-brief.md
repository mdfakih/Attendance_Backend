# Hosting brief — KamaiGo apps

For: DevOps engineer quoting hosting · 2026-10-29

We need hosting for three apps and a monthly cost quote for a **pilot of up to 1,000 employees**, growing to about **10,000**. Our own estimate is **≈ $30–55/month** for the pilot on managed services, or **≈ $40–55/month** on one small server. The database and file storage are already on Neon. Please confirm the setup below or propose a better one, and answer the checklist in section 6 with your quote.

Prices are in USD and exclude 18% GST. At $1 ≈ ₹95, $50 ≈ ₹4,750.

## 1. What we are hosting

| App | Repo | Tech | Runs as |
|---|---|---|---|
| API | [Attendance_Backend](https://github.com/mdfakih/Attendance_Backend) | Node.js 24, NestJS 12, Prisma 7 | One stateless HTTP process. No background worker, no cron jobs. Build `npm ci && npm run build`, start `node dist/main.js`, health `GET /health/ready` |
| Web dashboard | [Attendance](https://github.com/mdfakih/Attendance) | Next.js 16 | Vercel or any Node host. Calls the API server-side (`API_URL`) |
| Android app | [Attendance_Flutter](https://github.com/mdfakih/Attendance_Flutter) | Flutter 3.41 | Google Play. Calls the API over HTTPS only |

| Service | Used for | Status | Requirement |
|---|---|---|---|
| PostgreSQL 15+ | All data | **Already on Neon**, Singapore (ap-southeast-1) | Pooled `DATABASE_URL` for the app, direct `DATABASE_URL_UNPOOLED` for migrations |
| Redis 7 / Valkey | Cache, rate limits, 5-minute punch steps | Not set up | `REDIS_URL` (`rediss://` works). Light load; no persistence needed |
| S3-compatible storage | Selfies (~80 KB each), report exports | **Neon Object Storage** on the same project (Singapore); bucket `attendance` declared in `neon.ts`, created with `neon deploy` | Private bucket, presigned PUT/GET, path-style addressing (`S3_FORCE_PATH_STYLE=true`) |
| SMTP | Invites, activation codes, password resets | Not set up | Any SMTP, e.g. Amazon SES |
| Firebase Cloud Messaging | Push notifications | Optional | Service-account JSON in `FCM_SERVICE_ACCOUNT_JSON` |
| Domain + TLS | API and dashboard URLs | Not set up | HTTPS is mandatory (the Android app blocks plain HTTP) |

Pilot load: ~3 punches per employee per working day ≈ 80,000 punches/month, each 3–4 API calls; selfies upload straight to storage, not through the API. Selfie storage ≈ 6 GB/month, ≈ 19 GB kept at the default 90-day retention.

## 2. How it fits together

```
 Android app ──HTTPS──► API (NestJS) ──► PostgreSQL (Neon, Singapore)
     │                    │   └────────► Redis / Valkey
     │                    ├────────────► SMTP · Firebase push
     │                    └─ presigns ─┐
     └──── selfie PUT (presigned URL) ─┴► Neon Object Storage (private bucket, Singapore)

 Browser ──► Web dashboard (Next.js) ──server-side──► API
```

## 3. What the API needs from its host

- **Same region as the database.** Every page runs many small queries, so the API must sit next to Neon (Singapore). Putting it in India while the database stays in Singapore adds cross-region latency to each query.
- **No scheduler.** All periodic work (closing days, absent marking, selfie purge, leave accrual) now happens on reads or once per company per day, triggered by the first request. Nothing to schedule; any number of API copies is safe.
- **Request timeout ≥ 60 s.** Report exports are generated inside the request, and the first dashboard load of a day recalculates that day for the employees shown.
- **Migrations before each release:** `npm run db:deploy` with the direct database URL, then deploy.
- **Configuration:** every variable is listed in `.env.example`; the app refuses to start and lists what is missing. More detail: [deployment-brief.md](deployment-brief.md).
- **Storage:** map Neon's storage credentials to our variables: `S3_ENDPOINT` = the branch storage endpoint (`AWS_ENDPOINT_URL_S3` in the Neon console), `S3_ACCESS_KEY` / `S3_SECRET_KEY` = the Neon credential, `S3_REGION=ap-southeast-1`, `S3_BUCKET=attendance`, `S3_FORCE_PATH_STYLE=true`. Neon stores lifecycle rules but does not enforce them, so selfie retention relies on the app's daily housekeeping (selfies past retention are also hidden on read).
- **Logs:** JSON to stdout.

## 4. Options and indicative monthly cost

**Option A — managed services:** Vercel Pro hosts both the dashboard and the API (pinned to Singapore, `sin1`), with Neon (database and file storage) and Upstash Redis.
**Option B — one small server:** a Singapore VM runs the API, the dashboard and Valkey in Docker, with Neon (database and file storage).

| Item | Option A (pilot) | Option B (pilot) |
|---|---|---|
| App hosting | Vercel Pro $20: 1 deploying seat + $20 usage credit; extra deploying seats $20 each. Pilot API traffic is expected to fit the credit — check after month one | DigitalOcean Basic Droplet 4 GiB / 2 vCPU $24 + weekly backups $4.80 |
| PostgreSQL (Neon Launch) | ≈ $10–25: $0.106 per CU-hour (0.25 CU always on ≈ $19, less with scale-to-zero) + $0.35 per GB-month | Same |
| Redis | Upstash pay-as-you-go ≈ $0–5: 500K commands/month free, then $0.20 per 100K | Valkey on the server: $0 |
| File storage (Neon Object Storage) | ≈ $0.50: $0.023 per GB-month, no request fees; transfer out counts toward the 500 GB/month included on paid plans | Same |
| Email (SES) | < $1 | < $1 |
| **Total** | **≈ $30–55** | **≈ $40–55** |

At ~10,000 employees, a rough figure for either option is **≈ $110–250/month**:
- **Option A:** Neon 0.5–1 CU always on, Vercel usage beyond the credit, Upstash ≈ $20.
- **Option B:** two app servers, a load balancer, managed Valkey and Neon.

Please quote this tier too. Staging adds roughly $5–30: a Neon branch plus preview deployments, or one small extra server.

Not an option: Vercel's free Hobby plan is for non-commercial use only.

## 5. One-time and yearly costs

| Item | Cost | Note |
|---|---|---|
| Google Play developer account | $25 one-time | Organization account needs a D-U-N-S number (1–4 weeks lead time) |
| Domain | ≈ ₹1,000–1,500/year | Vercel Pro includes one free first-year domain on eligible TLDs (.app, .co, .dev, …) |
| TLS certificates | Free | Let's Encrypt, or included on Vercel |
| Apple Developer Program | $99/year | Only when the iOS app starts |

## 6. Please answer with your quote

- [ ] Option A, Option B, or a better setup, and why
- [ ] Monthly cost for the pilot (1,000 employees) and ~10,000 employees, plus staging
- [ ] Region: everything in Singapore next to Neon, or do clients require data in India? If India, which Postgres and region, and the cost of moving
- [ ] Domain and DNS plan (e.g. `api.<domain>`, `app.<domain>`) and who buys the domain
- [ ] Email provider, sender domain and SPF/DKIM setup
- [ ] Confirm Neon Object Storage for files (or name a reason to use S3/R2 instead)
- [ ] Where secrets live and who can read them
- [ ] CI/CD: build → `npm run db:deploy` → deploy, for API and dashboard; Play Store release flow for the app
- [ ] Backups and restore: Neon point-in-time restore window on the chosen plan
- [ ] Monitoring: uptime on `/health/ready`, error tracking, alerts
- [ ] Firebase project for push (service account for the API, `google-services.json` for the app)
- [ ] Anything you need from us to start

## Sources

- [Vercel Pro plan](https://vercel.com/docs/plans/pro-plan) · [Vercel Hobby plan](https://vercel.com/docs/plans/hobby-plan) · [NestJS on Vercel](https://vercel.com/docs/frameworks/backend/nestjs)
- [Neon pricing](https://neon.com/pricing) · [Neon plans: Object Storage](https://neon.com/docs/introduction/plans#object-storage) · [Neon S3 compatibility](https://neon.com/docs/storage/s3-compatibility) · [Upstash Redis pricing](https://upstash.com/pricing/redis)
- DigitalOcean, SES, Play Store and domain figures: [cost-estimate.md](cost-estimate.md) (October 2026)
