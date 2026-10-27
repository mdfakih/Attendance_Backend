# Implementation Plan: Attendance + Leave + Basic Pay Monitoring SaaS

## 1. Overview
Multi-tenant B2B SaaS for India.
- **Employee Android app:**
  - First login uses an employer-issued activation code; the device is bound with a hardware key.
  - Punching uses a selfie, a liveness check and GPS, with the geofence enforced.
  - Employees also apply for leave and, if the employer allows, see an earnings summary.
- **Employer web:** attendance operations, basic configurable leave, and **basic pay monitoring** (earned pay from attendance + leave, manual adjustments, monthly register, lock).
- **Superadmin console:** tenants, plans, `payrollTier` (BASIC | FULL), manual billing.

**FULL statutory payroll and Razorpay billing are deferred to a future phase** (build or integrate).

Repo `D:\attendance`: `Backend/` (NestJS), `Web/` (Next.js 15), `App/` (Flutter). The architect agent owns schema and design; assumptions are marked **[confirm w/ architect]**.

## 2. Working Assumptions & Decisions
| Area | Decision |
|---|---|
| Repo | One git repo: `Backend/`, `Web/`, `App/`, `infra/`, `docs/adr/`, `.github/workflows/`. CI per surface (path-filtered) |
| Contract | API-first. NestJS Swagger writes `Backend/openapi.json` (snapshot-tested). Web types via `openapi-typescript`. App: hand-written immutable Dart models + contract fixtures. Prism mock unblocks Web/App |
| Tenancy | Shared schema, `tenant_id` + Postgres RLS **[confirm w/ architect]** |
| Feature flags / settings | Typed registry (Phase 0). **Entitlements** (superadmin/plan) are separate from **toggles** (tenant admin). Values zod-validated, cached in Redis, audited, served at `/me/features` |
| Flag registry (v1) | `module.leave`, `module.pay`, `pay.monthlyDivisor` (`CALENDAR`\|`FIXED_26`\|`FIXED_30`\|`WORKING_DAYS`, default `CALENDAR`), `pay.weeklyDivisor` (default 6), `pay.hourlyRounding` (minutes, default 15), `pay.holidayPaidForHourly` (default false), `pay.showEarningsToEmployee` (default off), `attendance.hoursPolicy` (`FILO`\|`PAIRS`), `attendance.livenessMode` (`block`\|`flag`), `attendance.selfieRetentionDays` (90), `auth.activationCodeTtlHours` (168), `auth.activationAutoEmail` (on), `auth.deviceApprovalRequired` (off), `notifications.reminders`, `billing.autoSuspendAfterDays` (SA-level, default off) |
| **Payroll tier** | `payrollTier` = `BASIC`\|`FULL`, a tenant attribute set **only by superadmin**. Only BASIC is built: setting FULL → 422 `TIER_UNAVAILABLE` until a platform flag enables it. Pay code sits behind a `PayProvider` interface (`BasicPayProvider` now), so FULL (in-house or external) plugs in later without rework **[confirm w/ architect]** |
| **Basic pay** | One effective-dated gross rate per employee: `MONTHLY` (₹/month), `WEEKLY` (₹/week), `HOURLY` (₹/hour). No components/statutory deductions. Formulas:<br>• Monthly: `dayRate = rate / divisorDays`; `earned = rate − LOP days × dayRate` (floor 0); prorated for mid-month join/exit/revision segments.<br>• Weekly: `dayRate = weeklyRate / pay.weeklyDivisor`; `earned = dayRate × payable days`.<br>• Hourly: `rate × rounded worked hours` (+ paid-leave hours = leave days × duty hours).<br>LOP = absent days without leave + unpaid leave + half-day absences × 0.5. OT hours appear in the register only (OT pay = manual addition) |
| Pay outputs | Manual additions/deductions (reason required, audited); month-to-date (MTD) earned (up to yesterday); monthly register (Excel/PDF, async); month **finalise/lock** (immutable snapshot; attendance, leave and adjustment edits for that month blocked; Admin reopen with reason, audited); optional employee "Earnings summary" in the app (not a payslip) |
| Pay permissions | `pay.view`, `pay.manage`, `pay.lock` in the RBAC catalog; Managers have none by default |
| Leave | Basic, per tenant, can be switched off. Leave types (paid/unpaid, half-day, eligibility, attachment, max consecutive, holiday/off counting, sandwich option), quotas/accrual (fixed, monthly, per days worked), append-only ledger, carry-forward cap/lapse, opening import, apply in app, single-level approval on web. Feeds attendance day status + LOP |
| **Superadmin billing (manual)** | Billing record per tenant period: plan, period (monthly/quarterly/annual), amount ₹, optional GST amount, due date, status `PENDING`/`PAID`/`OVERDUE`/`WAIVED`, mark-paid (date, mode, reference, note), invoice reference text. Daily job: past due → `OVERDUE`; next-period record created N days before period end; reminder email to tenant admins; optional auto-suspend after X days. Tenant admin sees a read-only billing page + overdue banner. No payment gateway, no invoice PDF |
| Employer auth | Email + password (argon2id), access JWT + rotating refresh in httpOnly cookies, CSRF, reuse detection. Admin TOTP in Phase 2 |
| Superadmin | `(superadmin)` route group on `admin.` subdomain; separate realm + mandatory TOTP |
| Employee auth | No OTP, no Firebase Auth. Phone + 8-char activation code (or QR) → API verifies → Keystore ECDSA P-256 device key registered + Play Integrity → device-bound tokens → PIN/biometric. Refresh and punch requests are signed by the device key. No logout |
| Activation code | No-look-alike 32-char alphabet, CSPRNG, ~40 bits, single-use, expiry from settings, purposes `ACTIVATION`/`PIN_RESET`. Verified via HMAC-SHA256 + KMS pepper (constant-time). Encrypted reveal copy kept while active (permission-gated, audited) **[confirm w/ user/architect]**. Issued automatically on create, bulk upload and device release; email, QR card, bulk Excel/QR PDF |
| Brute force | Locks after 5 fails per code; Redis limits per IP/phone/install id; identical responses; anomaly alerts |
| Device approval mode | Per-tenant option; activation selfie + liveness; `PENDING` until Admin/Manager (`devices.approve`, site scope) approves; reject voids the code |
| PIN | Server-side argon2id; 5 wrong → locked → employer-issued `PIN_RESET` code |
| Phone | One phone = one tenant (global `phone_registry`, generic 409, freed on exit, superadmin resolves conflicts) |
| Device trust | Keystore key (StrongBox → TEE), Play Integrity at bind + punch, minSdk 26, no non-Google-Play devices in v1. iOS later: Secure Enclave + App Attest behind `DeviceKeyService` |
| Firebase | FCM only (Spark plan) |
| Liveness / geofence / punching | ML Kit challenge, `flag` default. Geofence: server accepts if `distance ≤ radius + min(accuracy, 50m)`, rejects if accuracy > 150m. Online-only, idempotent, holiday block with override |
| Hours | Default FILO (last − first); pairs as an option; shifts, overnight, grace/late, half-day, OT hours; effective-dated |
| Time / money | Stored in UTC, tenant timezone (`Asia/Kolkata`), Luxon. Money in `Decimal(14,2)` + decimal.js; register rounding to ₹1 configurable |
| Exit | Exit date → revoke tokens, release device, invalidate codes, free phone, stop reminders, prorate earned pay. Full DPDP deletion workflow in Phase 2 |
| Web / Flutter / jobs | Web: react-hook-form + zod, MUI 6, TanStack Query 5, next-intl, Google Maps. Flutter: CRM-App conventions, `mobile_scanner`, own Keystore channel. BullMQ queues: `attendance`, `leave`, `pay`, `exports`, `pdf`, `email`, `notifications`, `billing`, `purge`. Chromium in `pdf` worker, exceljs |
| Hosting | AWS `ap-south-1` (RDS PG16, ElastiCache, S3, ECS Fargate, KMS, SES) |

## 3. Phase Shape (and Why)
- **Phase 0 Foundations (3 wk):** repo, CI, tenancy, RBAC, feature flags, activation-code auth + device key + brute-force protection. Every later module depends on these.
- **Phase 1 Product MVP + pilot (18 wk):** attendance + basic leave + basic pay monitoring + superadmin (tenants, plans, payroll tier, manual billing), end-to-end on all three surfaces. Delivered as **three milestones that can each be merged on their own**, because 18 weeks is too long for one merge unit:
  - **1a Attendance core (wk 1–9):** org, employees, activation, devices, punch, hours, dashboard, exports, superadmin tenants/plans.
  - **1b Leave + pay + billing (wk 8–15):** leave, salary rates, earned pay, adjustments, MTD, register, lock, employee earnings, manual billing, exit.
  - **1c Pilot (wk 16–18):** field test, load, abuse test, security review, 2-week pilot.
- **Phase 2 Hardening, iOS, scale (7 wk):** audited impersonation, DPDP deletion workflow, admin TOTP, tenant offboarding, iOS (Secure Enclave, App Attest, App Store), Hindi + languages, partitioning, DR, WAF, VAPT, accessibility.
- **Phase 3 (future, outline only):** FULL payroll tier (build vs integrate), Razorpay subscription billing, GST invoices.

## 4. Timeline & Effort (1 BE, 1 Web, 1 Flutter, QA ~0.5 FTE)
Start Mon 2 Nov 2026. pw = person-weeks.

| Phase | Calendar | BE | Web | App | QA | Total pw |
|---|---|---|---|---|---|---|
| 0 Foundations | 2 Nov – 20 Nov 2026 (3 wk) | 4 | 2.5 | 2.5 | 0.5 | 9.5 |
| 1 MVP (1a + 1b + 1c) | 23 Nov 2026 – 26 Mar 2027 (18 wk incl. 1 holiday wk) | 15 | 16 | 12 | 5.5 | 48.5 |
| 2 Hardening, iOS, scale | 29 Mar – 14 May 2027 (7 wk) | 5 | 4 | 5 | 3 | 17 |
| **Total (built scope)** | ~28 wk | 24 | 22.5 | 19.5 | 9 | **75** |
| 3 Future (not scheduled) | — | see §5 | | | | 6–45 |

- Previous plan with full payroll + Razorpay: 107.5 pw. **Now 75 pw.**
- Contingency +15% → GA around early June 2027.
- **Web dev is the Phase 1 bottleneck** (~16 pw UI). The backend dev keeps all API work, so no W-able API tasks are needed.
- The Flutter dev has ~4–5 pw spare in Phase 1 → start M2-01 iOS enablement and M2-04 Hindi early (wk 13+).
- A 2nd backend dev and the CA engagement are no longer required.

## 5. Phases

### Phase 0 — Foundations (3 wk)
**Scope:**
- Repo, CI + coverage gates, security scans, compose stack (PG, Redis, MinIO, Mailpit).
- NestJS scaffold, Prisma, tenancy + RLS, employer + superadmin auth, RBAC, feature flags.
- Activation code service + exchange + device key + signed refresh + brute-force protection; email module.
- Audit log, BullMQ, S3.
- Web scaffold/client/login/shell/gated nav.
- Flutter scaffold, network, DeviceKeyService, signed refresh, FCM, feature provider.
- Staging; external accounts.

**Exit criteria:**
- [ ] Compose stack up; CI enforces lint, types, tests, 80% coverage, scans; merge deploys staging.
- [ ] Tenant isolation test green.
- [ ] Employer + superadmin auth pass Playwright.
- [ ] Dev app: phone + code → device key → `/me` + `/me/features`; unsigned refresh → 401.
- [ ] Brute-force suite green (lock at 5, 429 limits, identical responses, constant-time).
- [ ] Every route has permission (+ feature) metadata; flag off → 403 within 5s.

### Phase 1 — Product MVP + Pilot (18 wk)
**1a Attendance core (wk 1–9):**
- API: org/sites; employees + phone registry + auto codes; bulk upload; activation tools; device approval mode; devices; PIN reset; consent; selfie; punch + Integrity; hours engine; attendance day; manual mark; self + dashboard endpoints; exports; FCM reminders; selfie purge; superadmin tenants, plans/entitlements, trial, caps, `payrollTier`; usage; users; flagged punches.
- Web: the matching screens.
- App: activation, QR, bind, approval pending, consent, PIN + reset, permissions, location, liveness, integrity, punch, home, calendar, FCM, profile, force update.

**1b Leave + pay + billing (wk 8–15):**
- **Leave:** config, ledger + opening import, accrual/year-end, apply/cancel (app), approvals (web), leave → attendance, reports.
- **Pay:** salary rates, earned-pay engine, pay settings, manual adjustments, monthly compute + MTD, register + exports, finalise/lock/reopen, employee earnings (optional).
- **Billing:** superadmin billing records + mark paid, overdue/renewal/reminder jobs, tenant billing page + banner.
- **Exit:** employee exit flow.

**1c Pilot (wk 16–18):** field test, k6, abuse test, security review, Play closed track, 2-week pilot with 1–2 tenants.

**Out:** statutory deductions, payslips, bank files, Razorpay, GST invoices, impersonation, iOS release.

**Exit criteria:**
- [ ] Goldens green: hours ≥ 40, leave ≥ 25, **earned pay ≥ 30** (each divisor mode, weekly, hourly + rounding, mid-month join/exit/revision, half-day, unpaid leave, holidays/off, adjustments); engines ≥ 95% coverage.
- [ ] Cross-surface: apply leave in app → approve on web → calendar status → LOP → register earned amount correct; `module.leave` off → LOP from absent days only.
- [ ] Register for 1k employees exports Excel/PDF < 2 min; lock snapshot equals the pre-lock register (byte-compare); edits to a locked month → 409 `MONTH_LOCKED`; reopen audited.
- [ ] MTD on dashboard and (if enabled) in the app matches the register up to yesterday; setting off → app hides earnings and API returns 403.
- [ ] `payrollTier` FULL → 422 `TIER_UNAVAILABLE`; BASIC gates the pay module; pay endpoints respect `pay.*` permissions.
- [ ] Manual billing: overdue job flips status; reminder email in Mailpit; auto-suspend (when set) suspends; mark-paid unsuspends; all audited.
- [ ] Activation E2E (code, QR, approval mode, release → new code, PIN reset); Q1-08 abuse test passes.
- [ ] Field test: geofence false-reject < 5%, liveness false-reject < 3%; k6 5k punches/10 min p95 < 800 ms.
- [ ] Playwright + Flutter integration_test green; Play closed track approved; data safety form filed.
- [ ] 2-week pilot with no P1 open; security review clean of CRITICAL/HIGH.

### Phase 2 — Hardening, iOS, Scale (7 wk)
**Scope:** audited impersonation (cannot reveal codes); DPDP deletion workflow (post-exit purge per retention, keep pay registers for the retention period, data-principal requests); admin TOTP; tenant export/offboarding; iOS (Secure Enclave key, App Attest, sensor parity, App Store); Hindi + more languages; OEM guidance; low-end performance; punch partitioning; impossible-travel/Wi-Fi assist; WAF, autoscaling, PITR + DR drill, SLOs, VAPT; accessibility.

**Exit criteria:**
- [ ] iOS approved on the App Store.
- [ ] Load: 50k-employee tenant, 20k punches/15 min p95 < 800 ms, register for 10k employees < 5 min.
- [ ] DR restore < 2 h, RPO ≤ 15 min.
- [ ] VAPT: 0 open CRITICAL/HIGH.
- [ ] Lighthouse ≥ 90 / WCAG AA.
- [ ] GA.

### Phase 3 — Future (outline only, no tasks)
**Trigger:** pilot/customer demand for statutory payroll + paid self-serve billing. Decision gate at end of Phase 2.

1. **FULL payroll tier**, enabled per tenant via `payrollTier=FULL`.
   - **Option A — integrate (preferred first look).** Evaluate RazorpayX Payroll, Zoho Payroll, greytHR, Keka for partner APIs, employee sync, input push, payslip pull-back, commercial terms. **Partner API availability has not been verified.**
     - Scope: provider adapter behind `PayProvider`; employee + salary sync; monthly inputs push (payable days, LOP, hours, adjustments from the locked register); payslip/earnings pull-back to the app; reconciliation report.
     - Est. **6–12 pw**.
   - **Option B — build in-house.**
     - Scope: salary components + Labour Code 50% wage rule, PF, ESI, PT/LWF (all states, data-driven, CA-verified), TDS (Income-tax Act 2025, old/new regime, declarations, proofs), arrears, payroll run lifecycle, payslip PDFs, bank advice/NEFT, statutory reports (ECR, ESI, PT/LWF, TDS return), annual statement, F&F, per-tenant/per-employee component toggles.
     - Est. **35–45 pw** + CA retainer.
     - Prerequisite: golden-file test suite signed by a CA.
2. **Razorpay subscription billing** (plans sync, subscriptions, webhooks, dunning → suspend), replacing manual status for self-serve tenants. Est. **3–4 pw**. Prerequisites: Razorpay KYC + Subscriptions activation (1–2 wk).
3. **GST invoices** (gapless series per FY, CGST/SGST vs IGST, PDF). Est. **1.5–2 pw**. Prerequisites: company GSTIN, CA review.

## 6. Critical Path
1. A0-07a code → A0-07b exchange + M0-08 device key → A1-07 binding → A1-11b punch → M1-10 → field test → **pilot**.
2. Play Console org account (D-U-N-S, 2–5 wk) → closed track by wk 14. *Start day 1.*
3. A0-13 flags → leave/pay/auth/billing gating.
4. A1-13 hours → A1-14 attendance day → A1-37 leave → attendance → A1-20 earned-pay engine → A1-41 monthly compute/MTD → A1-42 register → A1-43 lock → pilot.
5. Web UI throughput (bottleneck): 1a screens by wk 10, 1b screens by wk 15.
6. SES production access → auto-email codes + billing reminders (manual fallback exists).

## 7. Parallel Work Plan
| Weeks | API (BE) | WEB | APP | QA |
|---|---|---|---|---|
| P0 | scaffold, tenancy, auth, RBAC, flags, activation + brute force, email, jobs, storage | scaffold, client, login, shell, gated nav, SA shell | scaffold, network, device key, signed refresh, FCM, feature provider | strategy, device matrix |
| P1 wk 1–4 | org, employees + codes, bulk, shifts, holidays, devices, PIN, activation tools, consent, selfie | wizard, sites, employees, bulk, activation panel, policies, holidays | activation, QR, bind, consent, PIN + reset, permissions | hours goldens, brute-force script |
| P1 wk 5–9 | punch, integrity, hours, attendance day, manual mark, dashboard, exports, approval mode, SA tenants/plans/tier, users, flagged | dashboard, map, calendar, devices, approval queue, exports, users, settings, SA tenants/plans | location, liveness, integrity, punch, home, calendar, approval flow | integration review, Playwright 1a |
| P1 wk 8–15 | leave (7 tasks), salary rates, pay engine, adjustments, MTD, register, lock, employee earnings, billing records + jobs, exit | leave screens, pay settings, register, adjustments, lock, SA billing, tenant billing, exit, bulk code tools | leave app, earnings view, FCM, profile, force update, Play release; then iOS enablement + Hindi (early Phase 2 work) | leave + pay goldens, Playwright 1b, Flutter suite |
| P1 wk 16–18 | fixes, isolation suite, performance | fixes | fixes | field test, k6, abuse test, security review, pilot |
| P2 | impersonation, DPDP deletion, admin TOTP, offboarding, App Attest, partitioning, anomaly | impersonation, deletion, 2FA, offboarding, accessibility | iOS parity + release, languages, OEM, performance | load, iOS matrix, VAPT |

## 8. External Setup & Lead Times
| Item | Lead time | When | Notes |
|---|---|---|---|
| Firebase projects ×3 (FCM only) | 1 day | P0 wk 1 | Spark plan; APNs key for iOS in Phase 2 |
| SHA-1/SHA-256 in Firebase | 1 day, optional | P0 | Not required for FCM; register for App Check/future |
| Play Integrity API | 1 day + quota uplift 1–2 wk | P0 | Link Cloud project in Play Console |
| Play Console organisation account | 1–4 wk D-U-N-S + 1–7 days | **P0 day 1** | Avoids the personal-account closed-test rule |
| Play review (first app) | 1–7+ days | Submit P1 wk 14 | |
| Data safety form + privacy policy | 2–3 days + legal | P1 wk 10 | Location, photos, phone, device IDs, email, **earnings data** |
| AWS SES production access | 1–2 days | P0 | Codes, password resets, billing reminders |
| Google Maps Platform | 1 day | P0 | Restricted keys |
| Apple Developer (org) | 1–3 wk | Start P1 wk 10 | Needed for Phase 2 |
| Domain/DNS/TLS | 2–5 days | P0 | |
| DLT / SMS | **not needed** | — | Zero SMS |
| Razorpay KYC, GSTIN, CA, payroll provider partnership | 1–4 wk each | **Phase 3 only** | Start when the Phase 3 decision gate passes |

## 9. Risk Register
| # | Risk | L | I | Mitigation |
|---|---|---|---|---|
| R1 | **Earned-pay miscalculation** (divisor, proration, revisions, hourly rounding, half-days) | M | High | Pure engine, ≥ 30 hand-verified goldens, per-employee day breakdown in register, lock snapshot, pilot reconciliation vs tenant's existing sheet |
| R2 | **Customers treat basic pay as statutory payroll** | M | M | Label "Earnings summary / pay monitoring"; ToS disclaimer; register shows "no statutory deductions"; FULL tier roadmap |
| R3 | Device binding edge cases | H | High | Release → new code automatically; one employee per device; device-key signatures |
| R4 | Geofence accuracy indoors | H | High | Accuracy-aware rule, guidance, per-site radius, field gate |
| R5 | GPS spoofing / root / emulator | H | High | Mock + root checks, Integrity, signed payload, review queue |
| R6 | Liveness false rejects / replay | M | High | Random challenge, coaching, default `flag`, selfie audit |
| R7 | Play policy (camera/location/data safety) | M | High | Foreground location only, prominent disclosure, accurate form |
| R8 | Activation code leak/misuse | M | High | Single-use, expiry, audited reveal/export, 10-min links, approval mode, device-key binding |
| R24 | Brute-force guessing | M | High | ~40-bit codes, lock at 5, multi-key rate limits, identical responses, abuse test each release |
| R25 | Lockout DoS | L | M | Only the target code locks; one-click regenerate; alerts |
| R26 | Employer distribution burden | M | M | Auto codes, email, bulk Excel/QR, "not activated" filter |
| R27 | Keystore OEM quirks | M | M | TEE fallback, attestation level stored, release + new code recovery |
| R9 | Play Integrity quota/outage | L | High | Quota uplift, cache, degraded mode |
| R10 | **Web dev bottleneck in Phase 1** | H | M | Milestones 1a/1b; shared MUI table/form kit built in wk 1–2; backend keeps all API work; cut list ready (map clustering polish, leave reports, bulk QR PDF move to Phase 2 if late) |
| R11 | Morning punch spike | M | M | Direct-to-S3, lean punch path, k6 gate |
| R12 | Cross-tenant leak | L | Critical | RLS + guard + isolation suite |
| R13 | DPDP non-compliance | M | High | Consent before capture, purge jobs, exit flow now, deletion workflow in Phase 2 |
| R16 | Timezone/overnight/month-boundary bugs | M | High | UTC, tenant timezone, boundary goldens (incl. overnight shift crossing month end into a locked month) |
| R17 | OEM battery killers delay FCM | H | L | High-priority FCM, polling fallback, OEM guidance |
| R18 | Bad bulk XLSX data | H | M | Strict template, cell-level preview, idempotent commit |
| R19 | Global phone uniqueness blocks new employer | H | M | Generic 409, superadmin resolution, auto-free on exit |
| R21 | Leave/attendance edits after month lock | M | M | Hard block + audited reopen; register re-snapshot on re-lock |
| R28 | **Manual billing leakage** (missed overdue follow-up) | M | M | Daily overdue job, SA overdue dashboard, reminder emails, optional auto-suspend, tenant banner |
| R29 | **FULL tier promised in sales before decision** | M | M | `TIER_UNAVAILABLE` guard; roadmap note; decision gate at end of Phase 2 |
| R30 | Salary data exposure to Managers/impersonators | L | High | `pay.*` permissions default off for Managers; impersonation (Phase 2) masks pay unless explicitly allowed; audit pay views/exports |

## 10. Testing Strategy
**Gates:** coverage ≥ 80% per surface; engines (hours, leave, earned pay) + auth ≥ 95%; OpenAPI diff reviewed; Stryker mutation score ≥ 80% on engines.

| Layer | Tools | What |
|---|---|---|
| API unit | Jest | Hours, leave and earned-pay engines; geofence math; state machines (binding, month lock, billing status); flags; code generator; signatures |
| API golden | Jest + `Backend/test/golden/{hours,leave,pay}/<case>.json` | Hand-verified spreadsheet → JSON converter; `verifiedBy/verifiedOn/source`; pay cases: every divisor mode, weekly, hourly + rounding, join/exit/revision mid-month, half-day, unpaid vs paid leave, holiday/off, adjustments, overnight shift crossing month end |
| API integration | Jest + Testcontainers + supertest | Every endpoint: auth, permission, flag on/off, isolation, validation, error codes; activation; leave flows; pay compute/MTD/lock/reopen; billing jobs with fake clock; payrollTier guard |
| Brute-force / abuse | Jest (A0-07c) + attacker script vs staging (Q1-08) | Lock, limits, uniform responses, timing, PIN guessing, lockout DoS, alerts |
| Contract | OpenAPI snapshot + Dart fixtures | |
| Security | semgrep, gitleaks, osv-scanner, ZAP | |
| Load | k6 | Punch spike, dashboard, register compute/export for 1k/10k employees, bulk code export |
| Web unit | Vitest + RTL + MSW | zod schemas, gated nav, register grid, adjustment dialog, lock confirm, billing forms |
| Web E2E | Playwright vs compose + seeds | Onboarding, employees/bulk/codes, approval queue, dashboard, manual mark, leave (settings → approve), pay (rates → register → adjust → lock → export → reopen), SA (tenant, plan, tier, billing → overdue → suspend → mark paid), tenant billing banner |
| App unit/widget | flutter_test + mocktail | Activation input/QR parser, pending screens, PIN reset, punch pre-checks, reason codes, leave apply validation, earnings visibility |
| App integration | integration_test (+ Patrol) on CI emulator | Activate → PIN → punch → calendar → apply leave → earnings view; fakes via Riverpod overrides (`DeviceKeyService`, `QrScanner`, `LocationSource`, `CameraSource`, `LivenessDetector`, `IntegrityProvider`) |
| Device lab | Manual, 6 Android devices | Keystore variants, reinstall → release flow, GPS, camera, liveness, mock apps, root |
| UAT | Pilot | Register reconciled against tenant's existing manual sheet for 1 month |

## 11. Definition of Done (every task)
1. Test first (RED) → GREEN → refactor.
2. Coverage gate (engines + auth ≥ 95%).
3. Files ≤ 400 typical / 800 cap; functions < 50 lines; nesting ≤ 4.
4. Immutable patterns (TS `readonly` + `eslint-plugin-functional`; Dart `final`/`const`/`copyWith`; append-only ledger, audit, lock snapshots).
5. No hardcoded config (env schemas, tenant settings, pay divisors, code expiry/limits).
6. Explicit errors; envelope `{success, data, error:{code,message}, meta}`; auth errors generic.
7. code-reviewer pass after each feature; security-reviewer before commit (mandatory for auth, pay, billing).
8. OpenAPI updated; audit events; gated routes declare their feature.
9. Left in the working tree. **User commits.**

## 12. Open Questions (resolve by end of Phase 0)
- User/architect: activation code reveal model; QR payload content; `PayProvider` boundary.
- Product:
  - Default monthly divisor (proposed `CALENDAR`), weekly divisor (6), hourly rounding (15 min), hourly holiday pay (off).
  - Week-by-week register for weekly-paid staff (proposed: deferred).
  - Billing reminder cadence and auto-suspend default (off).
  - Plan → entitlement mapping; trial length (14 days).
- Legal: earnings-summary disclaimer wording; retention periods for pay registers and selfies.
- Resolved: FILO ✔, leave basic ✔, one phone = one tenant ✔, activation codes ✔, FCM only ✔, **BASIC tier only ✔, FULL + Razorpay deferred ✔**.
