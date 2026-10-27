# Running Cost Estimate

Status: Draft v0.1 · 2026-10-27

The estimate covers hosting and third-party services only; development effort is not included. Assumptions:

- $1 = ₹95. The rupee has been moving, so recheck before budgeting.
- Prices exclude 18% GST.
- DigitalOcean prices are from its official pricing pages (Oct 2026). AWS figures are ±30% estimates; price them in the AWS Pricing Calculator before committing.

## 1. Usage assumptions

| Item | Assumption |
|---|---|
| Punches | ~3 per employee per working day, 26 working days per month |
| Selfie size | ~80 KB after on-device compression (plus a small thumbnail) |
| Selfie retention | 12 months, then purged automatically (DPDP Act). 6 months halves storage |
| Selfie storage growth | ~6 MB per employee per month → ~75 MB per employee at steady state |
| Peak load | Morning punch peak; ~2 punches/sec at 10k employees, ~8/sec at 50k (light) |
| First login | Employer-issued activation code checked by our API. No SMS, so no per-login cost |

## 2. Hosting — DigitalOcean Bangalore (BLR1), recommended to start

All services run as Docker containers, so moving to AWS later only changes infrastructure, not code.

### Pilot — up to ~1,000 employees

| Item | Spec | $/month |
|---|---|---|
| App server (API + Web + worker + Redis in Docker) | Basic Droplet 4 GiB / 2 vCPU | 24.00 |
| Droplet weekly backups | +20% | 4.80 |
| Managed PostgreSQL | 2 GiB / 1 vCPU, daily backups included | 30.45 |
| Spaces object storage (selfies, exports) | 250 GiB + 1 TiB transfer included | 5.00 |
| **Total** | | **≈ $64 ≈ ₹6,100** |

### Growth — ~10,000 employees

| Item | Spec | $/month |
|---|---|---|
| API + Web servers | 2 × Basic Droplet 8 GiB / 4 vCPU | 96.00 |
| Worker server (payroll runs, PDFs, exports) | Basic Droplet 4 GiB / 2 vCPU | 24.00 |
| Load balancer | 1 node | ~12.00 |
| Managed PostgreSQL + standby node (failover) | 4 GiB / 2 vCPU × 2 (standby assumed same price) | ~121.80 |
| Managed Valkey (Redis-compatible: queues, cache) | 1 GiB | 15.00 |
| Spaces | ~750 GiB selfies → 500 GiB over the included 250 GiB | ~15.00 |
| **Total** | | **≈ $284 ≈ ₹27,000** |

### Scale — ~50,000 employees

| Item | Spec | $/month |
|---|---|---|
| API servers | 3 × General Purpose Droplet 8 GiB / 2 vCPU | 189.00 |
| Web servers | 2 × Basic Droplet 4 GiB / 2 vCPU | 48.00 |
| Worker servers | 2 × Basic Droplet 8 GiB / 4 vCPU | 96.00 |
| Load balancer | 2 nodes | ~24.00 |
| Managed PostgreSQL primary + standby + read replica (for reports) | 8 GiB / 4 vCPU × 3 | ~366.30 |
| Managed Valkey | 2 GiB (estimated) | ~30.00 |
| Spaces | ~3.75 TB selfies + extra transfer | ~85.00 |
| **Total** | | **≈ $838 ≈ ₹80,000** |

### Staging environment (all tiers)

One small Droplet + a 1 GiB managed PostgreSQL + Spaces: **≈ $30 ≈ ₹2,900/month**.

## 3. Hosting — AWS Mumbai (ap-south-1), for comparison

Choose AWS if enterprise clients require it, or if you want AWS-specific services or compliance reports. Expect roughly 1.5–2.5× the DigitalOcean cost: managed load balancers, NAT gateways, Multi-AZ databases and outbound data transfer all add line items.

| Tier | Rough $/month | Rough ₹/month |
|---|---|---|
| Pilot | 70 – 120 | 6,700 – 11,400 |
| Growth | 450 – 700 | 43,000 – 66,500 |
| Scale | 1,500 – 2,500 | 1.4 – 2.4 lakh |

Other India-region options: Google Cloud (Mumbai/Delhi), Azure (Pune/Chennai), and E2E Networks (Indian provider, MeitY-empanelled). Quote them if a client asks for one.

## 4. Third-party services

| Service | Price | Notes |
|---|---|---|
| OTP / SMS | **₹0. Not used** | First login uses employer-issued activation codes verified by our API. For reference, Firebase Phone Auth would have cost $0.07 (≈ ₹6.65) per SMS to India |
| Firebase Cloud Messaging (push) | Free | Free Spark plan is enough; no billing account needed |
| ML Kit face detection (liveness) | Free | Runs on the device |
| Reverse geocoding (punch address) | Free | Android's on-device geocoder; the geofence itself needs only coordinates |
| Dashboard maps | Google Maps JS: free tier (~10k map loads/month), then ~$7 per 1,000 | Or Leaflet with a free-tier OpenStreetMap tile provider |
| Transactional email (invites, payslips) | Amazon SES ~$0.10 per 1,000, or Zoho ZeptoMail | Under ₹500/month at these volumes |
| Error monitoring | Sentry free tier → Team plan ~$26/month | |
| Razorpay (subscription billing) | **Deferred; ₹0 for now.** Later: ~2% + 18% GST on the fee per payment, plus ~0.99% on recurring card subscriptions | For now the Superadmin records payments manually (bank transfer, UPI, cheque) at no cost |
| CI (GitHub Actions) | Free tier likely enough at first | |

## 5. One-time and yearly costs

| Item | Cost | Notes |
|---|---|---|
| Google Play developer account | $25 one-time (≈ ₹2,400) | Register as an **organization**. It needs a D-U-N-S number (free, can take 1–4 weeks). Personal accounts must first run a 14-day closed test with 12 testers |
| Apple Developer Program (when iOS starts) | $99/year (≈ ₹9,400) | |
| Domain | ~₹1,000–1,500/year | |
| SSL certificates | Free | Let's Encrypt or Cloudflare |
| Employee onboarding | ₹0 | Activation codes need no SMS. Firebase OTP would have cost ~₹8,600 per 1,000 employees |

## 6. Monthly total (DigitalOcean, incl. staging and services)

| Tier | Infra (prod + staging) | Services (maps, email, monitoring) | **Total ₹/month** | **≈ ₹ per employee** |
|---|---|---|---|---|
| Pilot (1k) | ~6,100 + 2,900 | ~300 – 1,000 | **≈ 9,300 – 10,000** | ~9.5 |
| Growth (10k) | ~27,000 + 2,900 | ~2,000 – 4,000 | **≈ 32,000 – 34,000** | ~3.3 |
| Scale (50k) | ~80,000 + 2,900 | ~3,000 – 6,000 | **≈ 86,000 – 89,000** | ~1.75 |

Per-employee cost falls quickly with scale. Even at pilot size, infrastructure is a small share of any realistic per-employee subscription price.

## 7. Recommendation

1. Start on **DigitalOcean Bangalore**: the cheapest India-region option with low operational overhead. Docker keeps an AWS move open.
2. **No OTP:** employer-issued activation codes remove SMS cost and DLT paperwork entirely. Firebase is kept only for free push notifications.
3. Keep selfies for **6–12 months**. This is the main storage cost driver, and DPDP favours short retention.
4. Start the **Google Play organization account / D-U-N-S** process now; it has the longest lead time.

## Sources

- DigitalOcean pricing: [Droplets](https://www.digitalocean.com/pricing/droplets), [Managed Databases](https://www.digitalocean.com/pricing/managed-databases), [Spaces](https://www.digitalocean.com/pricing/spaces-object-storage)
- [Google Cloud Identity Platform pricing (SMS per country, for reference)](https://cloud.google.com/identity-platform/pricing) · [Firebase pricing](https://firebase.google.com/pricing)
- [Razorpay pricing explainer](https://razorpay.com/blog/razorpay-payment-gateway-pricing-explained/)
- AWS Mumbai indicative: [db.t4g.medium (Vantage)](https://instances.vantage.sh/aws/rds/db.t4g.medium), [t4g.medium (cloudprice)](https://cloudprice.net/aws/ec2/instances/t4g.medium)
