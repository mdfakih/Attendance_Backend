# Task List

**ID format:** `<Surface><Phase>-<NN>`. Surfaces: **I** INFRA, **A** API, **W** WEB, **M** APP, **Q** QA.
Phase 0/1 IDs are kept from earlier drafts where the task survives (rows grouped by topic, so numbers aren't always in order). Phase 2 IDs are new. Phase 3 (future) has no tasks.
**Milestones:** 1a = attendance core, 1b = leave + pay + billing, 1c = pilot.
**Size:** 0.5–3 dev-days.
**DoD for every task:** tests first, ≥ 80% coverage (engines + auth ≥ 95%), code review, security review before commit, files ≤ 800 lines, immutable patterns, no hardcoded config, user commits.

---

## Phase 0 — Foundations

### INFRA
| ID | Title | Deps | Acceptance |
|---|---|---|---|
| I0-01 | Repo scaffold (`Backend/ Web/ App/ infra/ docs/adr/`, editorconfig, gitignore, CODEOWNERS, commitlint) | — | Clone + README run; bad commit message rejected |
| I0-02 | docker-compose dev stack (PG16, Redis7, MinIO, Mailpit) | I0-01 | Healthchecks green < 60s |
| I0-03 | CI per surface (lint, typecheck, test, coverage ≥ 80%) | I0-01 | Coverage < 80% blocks merge |
| I0-04 | CI security scanning (gitleaks, osv-scanner, semgrep, Dependabot) | I0-03 | Planted fake secret fails CI |
| I0-05 | Env/config convention + boot-time validation | I0-01 | Missing var → fail fast naming the var |
| I0-06 | Hosting ADR + staging (ap-south-1, KMS, SES sandbox) | I0-01 | Staging `/health` HTTPS; KMS keys created |
| I0-07 | External accounts (Firebase ×3 FCM, Play org, Integrity, Maps, SES production, domain) | — | `docs/external-setup.md` tracker |
| I0-08 | Staging deploy pipeline | I0-06, A0-02 | Merge → staging < 15 min |
| I0-09 | Observability (pino, Sentry ×3, uptime; activation + pay job metrics) | A0-01, W0-01, M0-01 | Codes/PINs/salaries never logged (test) |

### API
| ID | Title | Deps | Acceptance |
|---|---|---|---|
| A0-01 | NestJS scaffold (config, validation, envelope, Swagger, `/health`) | I0-01 | Invalid DTO → 400 envelope |
| A0-02 | Prisma + migrations + idempotent seed | A0-01, I0-02 | Re-runnable |
| A0-03 | Tenancy context + RLS | A0-02 | Tenant A cannot read/write B |
| A0-04 | Employer auth (argon2id, rotation + reuse detection, reset, cookies + CSRF) | A0-03 | Reuse revokes family |
| A0-05 | Superadmin realm + mandatory TOTP | A0-04 | Cross-realm rejected |
| A0-06 | RBAC catalog (incl. `pay.*`, `leave.*`, `devices.approve`, `employees.activation.*`) + guard | A0-04 | Every route has permission metadata |
| A0-07a | Activation code service (alphabet, CSPRNG, HMAC + pepper, reveal copy, purposes, expiry, single-use, regenerate, lock at 5, audit) | A0-03, A0-08, A0-13, I0-06 | Unit suite incl. 1M uniqueness; reveal copy deleted on use |
| A0-07b | Activation exchange + device-key registration + signed refresh | A0-07a, A0-04 | Unsigned/replayed refresh → 401; 2nd device → 409 |
| A0-07c | Brute-force protection + integration suite | A0-07b, A0-09 | Lock at 5; 429 per key; byte-identical failures |
| A0-08 | Audit log (append-only) | A0-03 | DB blocks update/delete |
| A0-09 | Rate limiting + helmet + CORS | A0-01 | 429 on limits |
| A0-10 | BullMQ + worker + DLQ + Bull Board (SA) | A0-01, I0-02 | 3 retries → DLQ |
| A0-11 | Storage service | A0-03 | Cross-tenant GET denied |
| A0-12 | OpenAPI publish + Prism mock | A0-01 | Spec diff gate |
| A0-13 | Tenant settings + feature flags (entitlement vs toggle, registry incl. `module.*`, `pay.*`, `auth.*`, `attendance.*`) | A0-03, A0-06, A0-08 | Off → 403 `FEATURE_DISABLED`; cache < 5s |
| A0-14 | Email module (SES/Mailpit, templates, bounce log) | A0-10 | Mailpit receives in test |

### WEB
| ID | Title | Deps | Acceptance |
|---|---|---|---|
| W0-01 | Next 15 TS scaffold (MUI 6, TanStack Query, Vitest, Playwright) | I0-01 | Sample tests green |
| W0-02 | API client (types, CSRF, envelope, 401 refresh) | W0-01, A0-12 | Unit tests |
| W0-03 | Auth pages + guard | W0-02, A0-04 | Playwright login |
| W0-04 | App shell (permission nav) | W0-03 | Hidden without permission |
| W0-05 | Superadmin shell (`admin.` host, TOTP) | W0-03, A0-05 | Tenant cookie blocked |
| W0-06 | Feature-gated nav/routes | W0-04, A0-13 | Disabled page on direct URL |
| W0-07 | **Shared UI kit** (server-paged data table, filter bar, form fields, confirm/reason dialog, export button, status chips) | W0-04 | Storybook-less RTL tests; used by every list screen |

### APP
| ID | Title | Deps | Acceptance |
|---|---|---|---|
| M0-01 | Flutter scaffold (CRM-App layout, flavors, dart-define, lints, mocktail) | I0-01 | 3 flavors build; iOS compiles |
| M0-02 | Core network (dio, interceptor, ApiFailure, retry) | M0-01, A0-12 | Unit tests |
| M0-03 | FCM per flavor | M0-01, I0-07 | Test push received |
| M0-04 | go_router + splash + activation/lock guard | M0-01 | Redirect widget tests |
| M0-05 | Secure storage + install id | M0-01 | Stable across restart |
| M0-06 | CI Android build + emulator integration_test | M0-01, I0-03 | Passes on API 34 emulator |
| M0-07 | Feature provider (`/me/features`) | M0-02, A0-13 | Module off → tab absent |
| M0-08 | DeviceKeyService (Keystore P-256, StrongBox → TEE, sign, iOS stub) | M0-01 | Signature verifies on API test vector |
| M0-09 | Signed refresh in interceptor | M0-02, M0-08, A0-07b | One signed refresh for concurrent 401s |

### QA
| ID | Title | Deps | Acceptance |
|---|---|---|---|
| Q0-01 | Test strategy, seeds, device matrix | — | `docs/testing.md` approved |
| Q0-02 | Golden-case spreadsheet template + JSON converter spec (hours, leave, pay) | — | Template + converter agreed |

---

## Phase 1 — Product MVP + Pilot

### API — 1a Attendance core
| ID | Title | Deps | Acceptance |
|---|---|---|---|
| A1-01 | Org setup (profile, sites, departments, designations) | A0-06 | CRUD + validation; audited |
| A1-02 | Employee CRUD + phone registry + auto ACTIVATION code + email | A1-01, A0-07a, A0-14 | Create → code + Mailpit email; generic 409 |
| A1-03 | SA phone-conflict resolution | A1-02, A0-05 | Audited; old tenant notified |
| A1-04 | Bulk XLSX (validate, preview, idempotent commit, codes + emails) | A1-02, A0-10 | 5k rows < 30s |
| A1-05 | Shifts + attendance policy (FILO default) | A1-01, A0-13 | Version-by-date |
| A1-06 | Holidays + per-employee override | A1-01 | Audited |
| A1-07 | Device mgmt (bind, release → new code, block, status) | A0-07b, A1-02 | Release revokes; new code issued |
| A1-08 | PIN + PIN_RESET code unlock | A1-07, A0-07a | Reset single-use |
| A1-29 | Employer activation endpoints (reveal, regenerate, reset code, email, QR card PDF) | A1-02, A0-14, A0-10 | Reveal audited; fails after use |
| A1-30 | Bulk activation tools (XLSX export, bulk QR PDF, bulk email; 10-min links; 24h purge) | A1-29, A1-18 | 1k < 2 min; permission enforced |
| A1-31 | Device approval mode (activation selfie, PENDING 72h, approve/reject, FCM + poll) | A1-07, A1-10, A1-21 | 3 outcomes tested |
| A1-09 | Consent | A1-02 | 403 `CONSENT_REQUIRED` |
| A1-10 | Selfie upload (PUNCH/ACTIVATION) | A0-11, A1-09 | Bad files rejected |
| A1-11a | Punch core (device-signed payload, idempotency, server time) | A1-07, A1-10 | Bad signature → 401 |
| A1-11b | Punch validation (geofence, accuracy, mock, holiday, liveness mode) | A1-11a, A1-05, A1-06 | One test per rejection code |
| A1-12 | Play Integrity verification (bind + punch) | A1-11a, A0-07b | Tampered/replayed rejected |
| A1-13 | Hours engine (pure; FILO default; OT hours) | — | ≥ 40 goldens; ≥ 95% coverage |
| A1-14 | Attendance-day aggregation (leave status slot) | A1-13, A1-11b, A0-10 | Idempotent recompute |
| A1-15 | Manual mark + reason + audit (blocked when month locked) | A1-14 | 409 `MONTH_LOCKED` after A1-43 |
| A1-16 | Employee self endpoints (calendar, day punches) | A1-14 | p95 < 300 ms |
| A1-17 | Dashboard endpoints (manager scope) | A1-14 | Scoped counts match |
| A1-18 | Async exports Excel + PDF (attendance register) | A1-17, A0-10 | 1k × month < 2 min |
| A1-21 | FCM reminders + approval-decision push | A1-05, A0-10, A0-13 | Not on holidays/off |
| A1-22 | Selfie purge | A1-10, A0-13 | Deleted + audited |
| A1-23 | SA tenants (create + admin invite, suspend/reactivate, **`payrollTier`** BASIC default; FULL → 422 `TIER_UNAVAILABLE`) | A0-05 | Suspended → 403; tier guard tested |
| A1-24a | SA trial + employee caps | A1-23 | Cap → 422 `PLAN_LIMIT`; trial expiry handled |
| A1-24b | SA plans (name, cap, price, entitlements, default tier) + per-tenant overrides | A1-24a, A0-13 | Plan change updates entitlements; audited |
| A1-25 | Usage stats (employees, activated devices, punches/day) | A1-23 | Nightly rollup |
| A1-26 | Employer users (invite, permission ticks, site scope) | A0-06 | Scope enforced |
| A1-27 | Flagged punch review | A1-11b | Audited; recompute |

### API — 1b Leave
| ID | Title | Deps | Acceptance |
|---|---|---|---|
| A1-32 | Leave config (year, types, half-day, eligibility, attachment, max consecutive, holiday/off counting, sandwich) | A0-13, A1-05 | Effective-dated; validation |
| A1-33 | Leave ledger (append-only) + balances + opening XLSX import | A1-32, A1-04 | Balance = ledger sum |
| A1-34 | Accrual + year-end jobs (fixed, monthly, per days worked; carry-forward cap; lapse) | A1-33, A1-14 | Idempotent; ≥ 10 goldens |
| A1-35 | Apply/cancel API (range, half-day, day-count, balance, negative-balance setting; blocked for locked months) | A1-33, A1-06 | Overlap/balance → 422 |
| A1-36 | Approval API (permission + scope, reason, audit, FCM) | A1-35, A1-26, A1-21 | Scope 403; push sent |
| A1-37 | Leave → attendance (paid/unpaid leave status, half-day, punch-on-leave conflict flag, recompute) | A1-36, A1-14 | Conflict in review queue |
| A1-38 | Leave reports (balances, availed) + export | A1-34, A1-18 | Reconciles with ledger |

### API — 1b Basic pay (gated by `module.pay` + `payrollTier=BASIC`)
| ID | Title | Deps | Acceptance |
|---|---|---|---|
| A1-19 | Salary rates per employee (effective-dated MONTHLY/WEEKLY/HOURLY ₹; history; `pay.manage`) | A1-02, A0-06 | Rate-at-date lookup; overlap rejected; audited |
| A1-39 | Pay settings (divisors, hourly rounding, hourly holiday pay, show-to-employee) + `PayProvider` boundary | A0-13, A1-23 | Settings validated; FULL path not reachable |
| A1-20 | Earned-pay engine (pure; monthly divisor modes, weekly, hourly × rounded hours, LOP, half-days, join/exit/revision segments) | A1-19, A1-39, A1-13 | ≥ 30 goldens; ≥ 95% coverage; trace per day |
| A1-40 | Manual additions/deductions (per employee-month, reason required, audit, blocked when locked) | A1-19 | Reason required; 409 when locked |
| A1-41 | Monthly compute + MTD (recompute job on attendance/leave/rate/adjustment change; MTD up to yesterday; cache) | A1-20, A1-40, A1-37 | MTD equals full compute truncated at yesterday (property test) |
| A1-42 | Monthly salary register (per-employee rows + day breakdown) + Excel/PDF export | A1-41, A1-18 | 1k employees < 2 min; totals reconcile |
| A1-43 | Month finalise/lock + reopen (immutable snapshot; blocks attendance/leave/adjustment edits; Admin reopen with reason) | A1-42 | Snapshot byte-equal; edits → 409 `MONTH_LOCKED`; reopen audited |
| A1-44 | Employee earnings endpoints (MTD + locked months; only if `pay.showEarningsToEmployee`) | A1-41, A1-43 | Off → 403; own data only |

### API — 1b Billing + exit
| ID | Title | Deps | Acceptance |
|---|---|---|---|
| A1-45 | SA manual billing records (plan, period, amount, GST amount, due date, status, mark paid with mode/ref, waive, invoice ref) | A1-24b | State machine tests; audited |
| A1-46 | Billing jobs (overdue marking, next-period creation, reminder emails, optional auto-suspend, trial end) | A1-45, A0-10, A0-14 | Fake-clock tests for each transition |
| A1-47 | Tenant billing status endpoint + overdue banner flag | A1-45 | Tenant admin read-only |
| A1-48 | Employee exit (revoke, release device, invalidate codes, free phone, stop reminders, prorate pay) | A1-07, A1-02, A1-20 | Post-exit activation fails; phone freed; pay prorated |
| A1-28 | Isolation + permission + flag suite for all Phase 1 routes | A1-01..A1-48 | Generated tests green |

### WEB — 1a
| ID | Title | Deps | Acceptance |
|---|---|---|---|
| W1-01 | Setup wizard | W0-06, A1-01 | E2E |
| W1-02 | Sites editor (Google Map + radius) | W1-01 | Radius enforced |
| W1-03 | Shifts + policy (FILO preselected) | W0-07, A1-05 | zod tests |
| W1-04 | Holidays + overrides | W0-07, A1-06 | Override requires employee + date |
| W1-05 | Employees list (activation status, filters) | W0-07, A1-02 | URL-synced filters |
| W1-06 | Employee add/edit (code shown once) | W1-05 | `PHONE_IN_USE` guidance |
| W1-07 | Bulk upload | W1-05, A1-04 | Fixture E2E |
| W1-22 | Activation code panel (reveal, regenerate, reset code, email, QR card) | W1-06, A1-29 | Reveal audited |
| W1-23 | Bulk activation tools | W1-05, A1-30 | Mailpit receives N |
| W1-08 | Device management | W1-05, A1-07 | Reason + confirm |
| W1-24 | Device approval queue | W1-08, A1-31 | Approve + reject E2E |
| W1-09 | Dashboard summary + refresh | W0-07, A1-17 | Auto-refresh pauses when hidden |
| W1-10 | Dashboard table + filters | W1-09 | MSW combos |
| W1-11 | Punch map | W1-09, W1-02 | > 1k points smooth |
| W1-12 | Calendar + manual mark | W1-05, A1-15 | Audit visible; locked month read-only |
| W1-13 | Audit log viewer | W0-07, A0-08 | Paged |
| W1-14 | Exports UI | W0-07, A1-18 | Download |
| W1-15 | Users & permissions (incl. pay/leave perms) | W0-07, A1-26 | Manager sees ticked only |
| W1-17 | Settings: attendance + auth | W0-06, A1-05, A0-13 | Audited |
| W1-18 | Settings: module toggles (leave, pay) | W0-06, A0-13 | Unentitled not toggleable |
| W1-19 | Flagged punches queue | W1-09, A1-27 | Approve/reject |
| W1-20 | SA tenants (create, suspend, **payroll tier selector** with FULL disabled "coming later") | W0-05, A1-23 | E2E; FULL not selectable |
| W1-21 | SA plans, trial, caps, entitlements, usage, phone conflicts | W1-20, A1-24a, A1-24b, A1-25, A1-03 | Entitlement reflected |

### WEB — 1b
| ID | Title | Deps | Acceptance |
|---|---|---|---|
| W1-25 | Leave settings (year, types, accrual, carry-forward) | W1-18, A1-32 | Hidden when off |
| W1-26 | Leave balances + opening import + adjust | A1-33 | Audited |
| W1-27 | Leave approvals inbox + team leave calendar | A1-36 | E2E; scope |
| W1-28 | Leave reports | A1-38 | Download |
| W1-16 | Salary rate on employee (effective-dated history, basis, amount) | W1-06, A1-19 | Overlap error shown |
| W1-29 | Pay settings (divisors, rounding, show-to-employee) | W1-18, A1-39 | zod tests |
| W1-30 | Monthly register grid (filters, MTD column, per-employee day breakdown drawer) | W0-07, A1-41, A1-42 | Totals match API fixture; virtualised |
| W1-31 | Manual additions/deductions dialog (reason required) | W1-30, A1-40 | E2E; disabled when locked |
| W1-32 | Finalise/lock + reopen + register Excel/PDF export | W1-30, A1-43 | E2E lock → edits blocked → reopen with reason |
| W1-33 | Dashboard MTD earned widget (pay perms only) | W1-09, A1-41 | Hidden without `pay.view` |
| W1-34 | SA billing (records list, create, mark paid, waive, overdue filter, suspend link) | W1-21, A1-45, A1-46 | E2E overdue → mark paid → unsuspend |
| W1-35 | Tenant billing page + overdue banner | W0-06, A1-47 | Banner shows when overdue |
| W1-36 | Employee exit flow | W1-06, A1-48 | Confirm dialog; post-exit state shown |

### APP — 1a
| ID | Title | Deps | Acceptance |
|---|---|---|---|
| M1-01 | Activation screen (phone + code) | M0-04, A0-07b | Format + error tests |
| M1-17 | QR scan activation (host allowlist) | M1-01 | Foreign-host QR rejected |
| M1-02 | Device bind + DEVICE_BOUND screen | M1-01, M0-08, M0-09, A1-07 | Integration test |
| M1-03 | Consent + prominent disclosure | M1-02, A1-09 | Punch unreachable without consent |
| M1-18 | Approval-pending flow | M1-02, M1-07b, A1-31 | 3 outcomes |
| M1-04 | PIN + biometric + lock | M1-02, A1-08 | 5 wrong → locked |
| M1-19 | Forgot PIN → reset code | M1-04, A1-08 | Integration test |
| M1-05 | Permissions flow | M1-03 | Denied states |
| M1-06 | Location service | M1-05 | Fake-source tests |
| M1-07a | Camera + ML Kit | M1-05 | Quality gates |
| M1-07b | Liveness challenge | M1-07a | Payload schema |
| M1-08 | Play Integrity provider | M0-01 | Verified on staging |
| M1-09 | Punch pre-check | M1-06, A1-16 | Offline message |
| M1-10 | Punch submit (signed) | M1-07b, M1-08, M1-09, A1-11b | Integration in/out |
| M1-11 | Home | M1-10 | Holiday state |
| M1-12 | Month calendar + day detail | M1-11, A1-16 | Golden widget tests |
| M1-13 | FCM handling + deep links | M0-03, M0-04, A1-21 | Tap → target screen |
| M1-14 | Profile + device info | M1-04 | Bound device shown |
| M1-15 | Force update | M0-02 | Blocking screen |

### APP — 1b / 1c
| ID | Title | Deps | Acceptance |
|---|---|---|---|
| M1-20 | Leave balances + apply + history + cancel | M0-07, A1-35 | Integration apply → pending |
| M1-21 | Leave in calendar + approval notifications | M1-20, A1-36, A1-37 | Push deep-links |
| M1-22 | Earnings summary (MTD + locked months; hidden when off; "not a payslip" label) | M0-07, A1-44 | Off → no tab; amounts match fixture |
| M1-16 | Play release prep (signing, data safety incl. earnings data, privacy URL, closed track) | M1-10, M1-22, I0-07 | Closed track approved |

### INFRA
| ID | Title | Deps | Acceptance |
|---|---|---|---|
| I1-01 | Prod env (RDS Multi-AZ, backups, S3 lifecycle) | I0-06 | Lifecycle verified |
| I1-02 | Prod deploy with approval + migration guard | I1-01, I0-08 | Rollback documented |
| I1-03 | Secrets Manager + KMS (pepper, reveal key) | I1-01 | Rotation runbook |

### QA
| ID | Title | Deps | Acceptance |
|---|---|---|---|
| Q1-01 | Hours goldens ≥ 40 | Q0-02 | Merged |
| Q1-09 | Leave goldens ≥ 25 | Q0-02, A1-34 | Merged + green |
| Q1-10 | Earned-pay goldens ≥ 30 (all divisor modes, weekly, hourly, join/exit/revision, half-day, leave, adjustments, month-end overnight) | Q0-02, A1-20 | Hand-verified; green |
| Q1-02 | Playwright suites (1a + leave + pay + SA billing) | W1-* | Green |
| Q1-03 | Flutter integration_test suite (activation, punch, leave, earnings) | M1-22 | Green on CI emulator |
| Q1-11 | Cross-surface E2E: app leave → web approve → register → lock → app earnings | M1-22, W1-32 | Green |
| Q1-12 | Stryker on hours, leave, pay, activation | A1-20, A1-34, A0-07a | Mutation score ≥ 80% |
| Q1-04 | Field test (6 devices × 3 sites; Keystore; reinstall) | M1-10, A1-11b | Thresholds met |
| Q1-05 | k6 (punch spike, register 1k/10k, bulk codes) | A1-11b, A1-42, A1-30 | Targets met |
| Q1-08 | Brute-force / abuse test vs staging | A0-07c, A1-08, A1-29 | No code guessed; report |
| Q1-06 | Security review (ZAP, ASVS spot-check, auth + pay + billing access review) | A1-28, Q1-08 | No CRITICAL/HIGH |
| Q1-07 | Pilot UAT (2 weeks, register reconciled vs tenant sheet) | Q1-02..Q1-12, M1-16 | Sign-off; no P1 |

---

## Phase 2 — Hardening, iOS, Scale

### API
| ID | Title | Deps | Acceptance |
|---|---|---|---|
| A2-01 | Audited impersonation (reason, 30 min, read-only default; no code reveal; pay masked unless allowed) | A0-05, A0-08 | Actions tagged; sensitive reads blocked |
| A2-02 | DPDP deletion workflow (post-exit purge per retention; keep pay registers; data-principal requests) | A1-48, A1-22 | Purge report; retained data list |
| A2-03 | Employer admin TOTP (enforceable) | A0-04, A0-13 | Non-2FA blocked when enforced |
| A2-04 | Tenant export + offboarding deletion | A2-02 | Export complete; deletion report |
| A2-05 | iOS App Attest + Secure Enclave key verification | M2-01 | Replay rejected |
| A2-06 | Punch partitioning + query tuning | A1-11b | 50k-seed p95 met |
| A2-07 | Impossible-travel flags + Wi-Fi BSSID assist | A1-11b | Flags in queue |

### WEB
| ID | Title | Deps | Acceptance |
|---|---|---|---|
| W2-01 | SA impersonation UI + banner | A2-01 | Banner on all pages |
| W2-02 | Data deletion / DPDP request UI | A2-02 | Irreversibility confirm |
| W2-03 | Admin 2FA setup + enforcement | A2-03 | E2E |
| W2-04 | SA tenant export/offboarding | A2-04 | Double confirm |
| W2-05 | Lighthouse ≥ 90 + WCAG AA | W1-* | axe: 0 serious |

### APP
| ID | Title | Deps | Acceptance |
|---|---|---|---|
| M2-01 | iOS enablement (build, APNs, usage strings, ML Kit, Secure Enclave DeviceKeyService) — may start P1 wk 13 | M1-10, M0-08 | iPhone activates + punches on staging |
| M2-02 | iOS sensor parity (location, liveness, notifications) | M2-01 | 2-iPhone checklist |
| M2-03 | iOS TestFlight → App Store | M2-02, A2-05 | Approved |
| M2-04 | Hindi localisation — may start P1 wk 13 | M1-22 | No hardcoded strings |
| M2-05 | More languages (ta, te, kn, mr, bn) | M2-04 | ARB complete |
| M2-06 | Low-end performance | M1-12 | Cold start < 3s on 2 GB device |
| M2-07 | OEM battery guidance + poor-network UX | M1-13 | Per-OEM guidance |

### INFRA
| ID | Title | Deps | Acceptance |
|---|---|---|---|
| I2-01 | WAF + autoscaling | I1-01 | Scales under k6 |
| I2-02 | PITR + DR drill | I1-01 | Restore < 2 h |
| I2-03 | SLOs, alerts, cost monitors (activation abuse, billing overdue, pay job failures) | I0-09 | Alerts fire in drill |
| I2-04 | Third-party VAPT (CERT-In empanelled) | Q1-06 | Report received |

### QA
| ID | Title | Deps | Acceptance |
|---|---|---|---|
| Q2-01 | Load at scale (50k employees, 10k register) | A2-06, I2-01 | Targets met |
| Q2-02 | iOS regression matrix | M2-03 | Green |
| Q2-03 | VAPT remediation verification | I2-04 | 0 CRITICAL/HIGH |
| Q2-04 | Coverage gap closure + regression review | all | ≥ 80% all surfaces; engines + auth ≥ 95% |

---

## Phase 3 — Future (no tasks; see implementation-plan §5)
- FULL payroll tier (integrate first: RazorpayX Payroll / others; else in-house statutory build).
- Razorpay subscription billing.
- GST invoices.
