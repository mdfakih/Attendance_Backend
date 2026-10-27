# Product Requirements — Attendance & Pay SaaS

Status: Draft v0.2 · 2026-10-27

## 1. Overview

A multi-tenant B2B SaaS for Indian employers. Employees record attendance with a selfie and GPS location. The system calculates worked hours and earned pay per employee.

Pay comes in two tiers, and the Superadmin picks one per client:

| Tier | What it covers | Status |
|---|---|---|
| **Basic — pay monitoring** | Salary per employee (monthly / weekly / hourly, INR), earned pay from attendance and leave, manual adjustments, monthly salary register, exports | **Build now** |
| **Full — payroll suite** | Statutory payroll: PF, ESI, PT, LWF, TDS, payslips, bank advice file, statutory reports | Later: build in-house or integrate an external provider (e.g. RazorpayX Payroll) |

Three surfaces share one backend:

| Surface | Users | Platform |
|---|---|---|
| Employee app | Employees | Flutter, Android first (iOS later) |
| Employer dashboard | Admin, Manager | Web (Next.js) |
| Superadmin console | Platform team | Web (Next.js, separate auth) |

## 2. Goals

1. Attendance that can be trusted: a live selfie, an enforced geofence, server time, and a device bound to one employee.
2. Hours and earned pay that are correct and identical in the employee and employer views.
3. Pay figures produced from attendance data with no re-entry, and ready to feed the Full payroll suite later.
4. Easy onboarding: bulk employee upload, phone number + activation code, no passwords and no SMS costs.
5. A platform the business can run: clients, plans, pay tier, subscription and payment status.

## 3. Actors and roles

| Actor | Scope | Access |
|---|---|---|
| Superadmin | Platform | All tenants, plans, pay tier, billing status, audited impersonation |
| Admin | One tenant | Everything in the tenant; sets Manager permissions |
| Manager | One tenant (optionally limited to branches/departments) | Only modules × actions ticked by an Admin |
| Employee | Self | Mobile app: punch, calendar, hours, leave, earnings (if the tenant enables it) |

Permission grid for Managers: module (Employees, Attendance, Holidays, Leave, Pay, Reports/Exports, Devices, Settings) × action (view, create, edit, delete, export).

## 4. Decisions

| # | Topic | Decision |
|---|---|---|
| D1 | Stack | Next.js 15 (web) + NestJS (API) + PostgreSQL + Prisma + Redis/BullMQ + S3-compatible storage; Flutter app |
| D2 | Selfie | Captured in the app with an on-device liveness check (ML Kit blink/head turn). No server-side face match |
| D3 | Location | Geofence enforced: punch only inside the radius of an assigned site; mock-location detection |
| D4 | Offline punch | Not allowed. Network required; server time is authoritative |
| D5 | Hours | Multiple punches per day. Default policy "First-In-Last-Out": hours = last punch − first punch of the day. Tenant can switch to "sum of in/out pairs" |
| D6 | Pay tiers | Superadmin selects **Basic** or **Full** per tenant. Only Basic is built now. Full is deferred and may be an integration rather than an in-house build. Basic's data model is the input to Full |
| D7 | Roles | Admin above Manager; Admin ticks Manager module permissions |
| D8 | First login | **No OTP / no SMS.** The employer issues a one-time activation code; our API verifies it and binds the device. Firebase is used only for push notifications (free) |
| D9 | Platforms | Android first |
| D10 | Hosting | India region, provider TBD; see [cost-estimate.md](cost-estimate.md) |
| D11 | Leave | Basic leave module, configurable per tenant, and can be switched off. Approved leave feeds day status and pay calculation |
| D12 | Phone numbers | One phone number belongs to one tenant only: unique across all active employees. No tenant picker. The number is freed when the employee is deactivated |
| D13 | Optional modules | A tenant settings model switches optional features on/off: leave, device approval, employee earnings view, and (with Full) each statutory component and the bank advice file |
| D14 | Subscription billing | Manual for now: the Superadmin records plan, period, amount, due date and payment status. Razorpay integration deferred |

## 5. Functional requirements

### 5.1 Employee app

- **FR-E1 First login (activation):**
  1. The employee enters their phone number and the activation code from their employer (typed, or scanned from a QR).
  2. The API checks three things: the employee is active, the code is valid and unused, and no device is already bound.
  3. The API binds the phone's device key. The employee then sets a 4–6 digit PIN and may enable biometric unlock.

  The phone field can be prefilled from the SIM (Android Phone Number Hint), but that is a convenience, not proof.
- **FR-E2 Device binding:** one active device per employee. The app has no logout. Logging in on another phone is refused until an Admin/Manager releases the old device. Releasing a device automatically issues a new activation code.
- **FR-E2a Activation codes:**
  - 8 characters, without look-alike characters (0/O, 1/I)
  - single use, with a tenant-configurable expiry (default 7 days)
  - stored hashed
  - generated automatically when an employee is added (single or bulk)
  - five wrong attempts lock the code until the employer reissues it; requests are rate-limited per IP and per device
  - error messages never reveal whether a phone number exists
- **FR-E2b Forgotten PIN:** the employer issues a reset code, and the employee goes through the same activation flow on the same phone.
- **FR-E3 Unlock:** later app opens need a PIN or biometric only.
- **FR-E4 Punch:** a single "Punch" action captures:
  - a selfie taken live in the app (gallery not allowed), passing the on-device liveness check
  - GPS latitude, longitude and accuracy, plus the mock-location flag
  - device time; server time is recorded and authoritative

  The server rejects the punch if the location is outside the geofence, on a holiday or weekly off without an override, if the device isn't bound, or if the account is suspended.
- **FR-E5 Calendar:** month view coloured by day status (present, absent, half-day, holiday, weekly off, missing out-punch, leave). Tapping a day shows every punch (time, selfie thumbnail, location) and the hours worked.
- **FR-E6 Hours:** daily and monthly totals, calculated by the same server engine the employer dashboard uses.
- **FR-E7 Leave:** apply for leave, see balances and request status (when the leave module is on).
- **FR-E8 Earnings (optional tenant setting, default off):** month-to-date earned pay and past months' totals.
- **FR-E9 Consent:** at first login, a consent screen covers camera, location and data use (DPDP Act). Consent is stored with a version and timestamp.
- **FR-E10 Reminders:** push notification for a missing out-punch, configurable per tenant.

### 5.2 Employer dashboard

- **FR-W1 Employees:** add one, or bulk-upload an XLSX file using a downloadable template. Upload shows a validation preview with row-level errors before committing. Fields:
  - employee code (optional), name, phone, email
  - branch, department, assigned sites, shift
  - duty hours
  - salary basis (monthly / weekly / hourly) and amount in INR
- **FR-W2 Daily summary:** counts for present, absent, late, half-day, on leave, missing out-punch and on holiday; a live punch feed; a map of today's punches. Filters by date, branch, department and site, with refresh.
- **FR-W3 Search:** find any employee and view their attendance history, punches with selfies, leave, and pay records.
- **FR-W4 Holidays:** holiday calendars per tenant and per branch, plus weekly-off patterns. Punching is blocked on those days unless a per-employee, per-date override is granted.
- **FR-W5 Manual marking:** mark an employee present, absent or half-day for a date. A reason is mandatory and the change is written to the audit log (who, when, old → new).
- **FR-W6 Devices:** view each employee's bound device and release it, with a reason and an audit entry.
- **FR-W6a Activation codes:**
  - view or regenerate an employee's code
  - bulk-download codes as Excel (name, phone, code) for HR to share on their own channels
  - auto-email the code when the employee has an email address
  - print QR sheets
- **FR-W6b Device approval (optional tenant setting):** a new device binding stays *pending* until an Admin, or a Manager with permission, approves it. The approver sees the selfie taken at activation and the device model.
- **FR-W7 Sites/geofences:** create sites with a map pin and radius; assign employees to one or more sites.
- **FR-W8 Shifts and policies:**
  - shift start/end, duty hours, overnight shifts
  - grace period, half-day threshold, overtime rules
  - hours policy (D5)
- **FR-W9 Basic pay monitoring:**
  - **Salary history:** each employee's basis (monthly / weekly / hourly) and INR amount, with an effective-from date for every revision.
  - **Earned pay:**

    | Basis | Formula |
    |---|---|
    | Hourly | worked hours × rate, with an optional overtime multiplier |
    | Monthly | salary ÷ divisor × payable days |
    | Weekly | weekly salary ÷ the week's working days × payable days |

    The monthly divisor is a tenant setting: calendar days, 26, or working days in the month.
  - **Payable days:** present days + half-days × 0.5 + paid holidays + weekly offs + paid leave. Absent days and unpaid leave are loss-of-pay.
  - **Adjustments:** one-off additions or deductions (bonus, advance recovery, etc.), each with a reason and an audit entry.
  - **Month-to-date view:** a live earned figure per employee.
  - **Salary register:** a monthly register for all employees, with filters.
  - **Finalise:** locking a month freezes its figures; changes after that need an Admin to unlock, with an audit entry.
- **FR-W10 Exports:** Excel and PDF for attendance, hours, leave and the salary register. Large exports run in the background and give a download link.
- **FR-W11 Roles:** Admins invite users and set the Manager permission grid (section 3).
- **FR-W12 Leave (optional module):**
  - leave types: paid or unpaid, half-day allowed or not
  - quotas: yearly or monthly accrual, or a fixed amount
  - balances, with a carry-forward cap
  - employees apply from the app; Admins, and Managers with permission, approve or reject on the web

  Approved leave sets the day's status and feeds payable days.
- **FR-W13 Tenant settings:** switch optional features on/off (D13).

### 5.3 Superadmin console

- **FR-S1 Tenants:** onboard a client (company details, GSTIN, first Admin), set the plan, trial, employee cap and **pay tier (Basic / Full)**; suspend or reactivate. "Full" stays unavailable until that suite exists.
- **FR-S2 Billing (manual for now):**
  - plans (e.g. per active employee per month)
  - subscriptions: period, amount, due date, status
  - "mark paid" with a reference (bank transfer, UPI, cheque)
  - list of overdue tenants
  - suspension when payment is overdue (manual or after N days)
- **FR-S3 Insight:** active employees per tenant, punches per day, monthly recurring revenue, churn.
- **FR-S4 Support:** impersonate a tenant Admin, with an audit trail.

### 5.4 Later — Full payroll suite (outline only)

- Statutory components: PF, ESI, Professional Tax and LWF (rules for all states), TDS. Each is optional per tenant, with per-employee overrides where the law allows.
- Salary structures and components, arrears, payroll run lifecycle, payslips (PDF, also in the app), statutory reports.
- Bank advice file (NEFT bulk) export, optional per tenant.
- The build-or-integrate decision (e.g. RazorpayX Payroll) is taken when this phase starts. Basic's salary, attendance and leave data is the input either way.
- Subscription billing via Razorpay Subscriptions comes in the same later phase.

## 6. Non-functional requirements

| Area | Requirement |
|---|---|
| Tenant isolation | Every tenant-owned row carries `tenant_id`; isolation enforced in the data layer and covered by automated tests |
| Security | Tokens bound to the device key; rate limits on activation and punch; signed, short-lived selfie URLs; audit log for sensitive actions |
| Privacy (DPDP Act 2023) | Consent capture, selfie retention limit with automatic purge, data deletion when an employee leaves |
| Data residency | India-region hosting |
| Performance | Punch round-trip < 3 s on 4G; dashboard summary < 2 s for 10k employees |
| Availability | 99.5% in Phase 1, 99.9% target later |
| Time | Stored in UTC, displayed in the tenant time zone (default Asia/Kolkata) |
| Quality | TDD, 80%+ test coverage, unit + integration + E2E |
| Pay correctness | Hours and earned-pay calculations covered by table-driven tests against hand-verified cases; money stored as integer paise |

## 7. Out of scope (for now)

- Full payroll suite (section 5.4)
- Razorpay subscription billing
- Server-side face matching
- Offline punching
- iOS app (later phase)

## 8. Open questions

1. **Hosting provider:** choose after reviewing [cost-estimate.md](cost-estimate.md).
