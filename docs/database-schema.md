# Database Schema: Attendance + Pay Monitoring SaaS

> v1.1 · 2026-10-27 · PostgreSQL 17 · Prisma 6+ · Companion: `architecture.md`

## 0. Conventions

- **Naming:** snake_case tables/columns (`@@map`/`@map`); Prisma models PascalCase.
- **IDs:** `uuid` v7 generated in the app (`@default(uuid(7))`).
- **Time:** `timestamptz` (UTC). Business dates are `date` in tenant TZ (default Asia/Kolkata). Wall-clock is `time`. Months are stored as `date` (first of month).
- **Numbers:** money `numeric(14,2)` INR; rates `numeric(9,4)`; days `numeric(6,2)`; coordinates `double precision`.
- **Extensions:** `citext`, `pg_trgm`, `btree_gist`, `pgcrypto`.
- **Notation:**
  - `[T]` tenant-scoped. Implicit: `id uuid PK`, `tenant_id uuid NOT NULL → tenants`, `created_at`, `updated_at`, `UQ(tenant_id, id)`, RLS `tenant_isolation`. Every intra-tenant FK `→ x` is **composite** `(tenant_id, x_id) → x(tenant_id, id)`.
  - `[T-ro]` tenant-scoped, written only by `app_platform`; `app_tenant` gets SELECT via RLS.
  - `[G]` global. Implicit `id`, `created_at`, `updated_at`.
  - `[G-read]` global and readable by `app_tenant`.
  - `[A]` append-only: INSERT/SELECT only (+ listed column UPDATE grants); a trigger blocks DELETE.
  - `[P col]` partitioned monthly by RANGE on `col`; PK includes it.
  - `?` nullable · `=x` default · `UQ` unique · `PUQ … WHERE` partial unique · `IX` index · `CK` check · `→` FK.
  - Every FK column is indexed (tenant_id leading) unless covered by a listed UQ/IX.
- **Prisma limits:** partial uniques, exclusion constraints, RLS, partitions, triggers and column grants are written as hand SQL in migrations (`migrate dev --create-only`, then edit). CI runs `prisma migrate diff` and fails on unexpected drift.
- **Enum-like values that evolve** (`feature_key`, `perm_module`, export types, categories) are `text` with CK or registry validation, to avoid enum migrations.

## 1. Roles, RLS, shared SQL

```sql
CREATE ROLE app_owner;                    -- owns schema; migrations only
CREATE ROLE app_tenant NOINHERIT;         -- RLS enforced
CREATE ROLE app_platform BYPASSRLS;       -- platform modules, schedulers, auth lookup

CREATE FUNCTION app_current_tenant() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$;

-- generated per [T] table by migration helper
ALTER TABLE employees ENABLE ROW LEVEL SECURITY;
ALTER TABLE employees FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON employees
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

-- platform-managed feature rows: tenant may read, never write
CREATE POLICY tenant_features_write ON tenant_features FOR UPDATE
  USING (tenant_id = app_current_tenant() AND managed_by = 'TENANT')
  WITH CHECK (tenant_id = app_current_tenant() AND managed_by = 'TENANT');
-- (same predicate for INSERT/DELETE; SELECT uses tenant_isolation)

-- append-only pattern
CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS
$$ BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END $$;
REVOKE UPDATE, DELETE ON punches FROM app_tenant;
GRANT UPDATE (selfie_key, thumb_key, selfie_purged_at, integrity_flags,
              voided_at, voided_by, void_reason) ON punches TO app_tenant;
CREATE TRIGGER punches_no_delete BEFORE DELETE ON punches
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- month lock guard (attached to attendance-affecting tables; see §12)
CREATE FUNCTION assert_month_open(t uuid, d date) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM pay_periods WHERE tenant_id = t
             AND month = date_trunc('month', d)::date AND status = 'LOCKED') THEN
    RAISE EXCEPTION 'PERIOD_LOCKED' USING ERRCODE = 'P0001';
  END IF;
END $$;
```
Special RLS policies:
- `tenants`: SELECT where `id = current`.
- `users`: visible if `EXISTS (membership in current tenant)`.
- `consent_notices`: SELECT where `tenant_id IS NULL OR = current`.
- `audit_logs`: SELECT/INSERT where `tenant_id = current`.
- `outbox_events`: INSERT with check `tenant_id = current`.
- `refresh_tokens`: no grant to `app_tenant`.

## 2. Enums

```
tenant_status         TRIAL | ACTIVE | PAST_DUE | SUSPENDED | CANCELLED | DELETED
user_status           ACTIVE | DISABLED
platform_role         SUPERADMIN | SUPPORT | FINANCE | READONLY
role_kind             ADMIN | CUSTOM
employee_status       INVITED | ACTIVE | DEACTIVATED | EXITED          -- INVITED/ACTIVE hold the phone
binding_status        PENDING | ACTIVE | REVOKED
revoke_reason         RELEASED_BY_EMPLOYER | REJECTED | EMPLOYEE_DEACTIVATED | EMPLOYEE_EXITED | SECURITY | PLATFORM
code_purpose          ACTIVATION | PIN_RESET
code_status           ISSUED | USED | LOCKED | REVOKED | EXPIRED
code_channel          CREATE | REGENERATE | BULK_XLSX | EMAIL | RELEASE | PIN_RESET
key_security_level    STRONGBOX | TEE | SOFTWARE | UNKNOWN
auth_realm            EMPLOYEE | TENANT_USER | PLATFORM_USER
actor_type            EMPLOYEE | TENANT_USER | PLATFORM_USER | SYSTEM
gender                MALE | FEMALE | OTHER
geofence_mode         ASSIGNED_SITES | ANY_TENANT_SITE
hours_mode            FIRST_IN_LAST_OUT | SUM_OF_PAIRS
missing_out_treatment ABSENT | HALF_DAY | PRESENT_FLAGGED
day_type              WORKING | WEEKLY_OFF | HOLIDAY
work_treatment        NORMAL | HOLIDAY_OT
attendance_status     NOT_STARTED | IN_PROGRESS | PRESENT | HALF_DAY | ABSENT | MISSING_OUT
                      | LEAVE | HALF_LEAVE | HOLIDAY | WEEKLY_OFF | ON_DUTY
punch_source          APP | EMPLOYER
punch_direction       IN | OUT
reject_reason         OUTSIDE_GEOFENCE | MOCK_LOCATION | LOW_ACCURACY | NON_WORKING_DAY | ON_LEAVE
                      | BINDING_INACTIVE | BAD_SIGNATURE | NONCE_INVALID | RATE_LIMITED
                      | LIVENESS_INVALID | SELFIE_MISSING | TENANT_SUSPENDED | EMPLOYEE_INACTIVE
ot_state              NOT_APPLICABLE | PENDING | APPROVED | REJECTED
mark_action           SET | REVOKE
accrual_mode          NONE | FIXED_QUOTA | YEARLY_ACCRUAL | MONTHLY_ACCRUAL
day_part              FULL | FIRST_HALF | SECOND_HALF
leave_request_status  PENDING | APPROVED | REJECTED | CANCELLED
leave_entry_type      OPENING | ACCRUAL | CARRY_FORWARD | LAPSE | DEBIT | CREDIT | ADJUSTMENT | ENCASHMENT
salary_basis          MONTHLY | WEEKLY | HOURLY
pay_frequency         MONTHLY | WEEKLY
pay_status            OPEN | LOCKED
job_status            QUEUED | RUNNING | DONE | FAILED | EXPIRED | CANCELLED
subscription_status   TRIALING | ACTIVE | PAST_DUE | SUSPENDED | CANCELLED
charge_status         DRAFT | DUE | PARTIALLY_PAID | PAID | OVERDUE | VOID | WAIVED
```

## 3. Platform, tenancy, settings, features

```
tenants [G, special RLS]
  slug citext UQ · legal_name text · display_name text · gstin text? · pan text?
  state_code char(2) · billing_address jsonb · billing_email citext · timezone text ='Asia/Kolkata'
  status tenant_status ='TRIAL' · status_reason text? · support_access_allowed bool =true
  deleted_at? · created_by → platform_users ?
  IX(status)

tenant_settings [T, PK(tenant_id)]                     -- typed, always present, tenant-editable
  default_policy_id → attendance_policies ? · default_calendar_id → holiday_calendars ?
  activation_code_ttl_days smallint =7 CK 1..30
  default_site_radius_m int =100 · default_max_accuracy_m int =100 · default_accuracy_buffer_cap_m int =25
  pay_divisor text ='CALENDAR_DAYS' CK IN (CALENDAR_DAYS, FIXED_26, WORKING_DAYS)
  net_pay_rounding text ='NEAREST_RUPEE' CK IN (NONE, NEAREST_RUPEE) · week_start smallint =1 CK 1..7 (ISO)
  show_earnings_in_app bool =false
  selfie_retention_days int =90 CK 30..365 · exited_purge_days int =180
  require_play_integrity bool =false · admin_mfa_required bool =false
  features_version int =1 · extra jsonb ='{}' (Zod: locale, branding, notification prefs)

tenant_features [T, PK(tenant_id, feature_key)]       -- missing row = plan default ?? registry default
  feature_key text (PAYROLL, LEAVE, OVERTIME, DEVICE_APPROVAL, AUTO_EMAIL_ACTIVATION_CODES)
  managed_by text CK IN (TENANT, PLATFORM)            -- PAYROLL = PLATFORM
  enabled bool · config jsonb ='{}' (Zod per key; PAYROLL: {"tier": "BASIC" | "FULL"})
  updated_by_actor actor_type · updated_by_id uuid?

platform_users [G]
  email citext UQ · full_name text · password_hash text · mfa_secret_enc bytea · mfa_enabled bool
  role platform_role · status user_status · ip_allowlist cidr[]? · failed_logins smallint =0
  locked_until? · last_login_at?

platform_holiday_templates [G-read]
  year smallint · jurisdiction text ('IN' | state) · holiday_date date · name text · kind text
  UQ(year, jurisdiction, holiday_date, name)
```

## 4. Identity, auth, RBAC

```
users [G, special RLS]                                 -- tenant web users; one login across tenants
  email citext UQ · full_name text · phone_e164 text? · password_hash text? (null until invite accepted)
  mfa_secret_enc bytea? · mfa_enabled bool =false · email_verified_at? · status user_status
  failed_logins smallint =0 · locked_until? · password_changed_at? · last_login_at?

tenant_memberships [T]
  user_id → users (simple FK) · role_id → roles · status user_status ='ACTIVE'
  perm_version int =1 · last_active_at?
  UQ(tenant_id, user_id) · IX(tenant_id, role_id)

roles [T]
  name text · kind role_kind · description text? · is_system bool
  UQ(tenant_id, name) · PUQ(tenant_id) WHERE kind='ADMIN'

role_permissions [T]
  role_id → roles · module text (registry) · can_view · can_create · can_edit · can_delete · can_export bool =false
  UQ(tenant_id, role_id, module)

membership_scopes [T]
  membership_id → tenant_memberships · branch_id → branches ? · department_id → departments ?
  CK(num_nonnulls(branch_id, department_id) = 1)
  UQ NULLS NOT DISTINCT (tenant_id, membership_id, branch_id, department_id)

user_invitations [T]
  email citext · role_id → roles · scopes jsonb ='[]' · token_hash bytea UQ · invited_by → tenant_memberships
  expires_at · accepted_at? · revoked_at?
  PUQ(tenant_id, email) WHERE accepted_at IS NULL AND revoked_at IS NULL

activation_codes [T]                                   -- employer-issued; plaintext NEVER stored
  employee_id → employees · purpose code_purpose · code_hmac bytea · pepper_version smallint
  status code_status ='ISSUED' · failed_attempts smallint =0 CK 0..5 · expires_at timestamptz
  issued_via code_channel · issued_by_actor actor_type · issued_by_id uuid?
  used_at? · used_by_binding_id → device_bindings ? · locked_at? · revoked_at?
  PUQ(tenant_id, employee_id, purpose) WHERE status='ISSUED'   ← one live code per purpose
  IX(tenant_id, status, expires_at)
  code_hmac = HMAC-SHA256(pepper_vN, tenant_id|employee_id|purpose|normalized_code).
  Lookup: phone → live employee → live code → constant-time compare. 5th failure → LOCKED.

device_bindings [T]                                    -- one device per employee; history = rows
  employee_id → employees · activation_code_id → activation_codes ?
  install_id uuid · platform text ='ANDROID' · public_key_spki bytea · key_fingerprint bytea (sha256)
  key_alg text ='ES256' · key_security_level key_security_level · attestation_ok bool
  android_id_hmac bytea? · manufacturer text · model text · os_version text · app_version text
  fcm_token text? · fcm_token_updated_at? · integrity_last jsonb?
  status binding_status · activation_selfie_key text? · activation_selfie_sha256 bytea?
  activation_liveness jsonb? · approved_by → tenant_memberships ? · approved_at? · activated_at?
  last_seen_at? · revoked_at? · revoke_reason revoke_reason? · revoked_by_actor actor_type?
  revoked_by_id uuid? · revoke_note text?
  PUQ(tenant_id, employee_id) WHERE status IN ('PENDING','ACTIVE')
  IX(tenant_id, status, created_at DESC) (approval queue) · IX(tenant_id, employee_id, created_at DESC)
  IX(key_fingerprint) · IX(tenant_id, android_id_hmac)   -- "same phone as previous binding"

refresh_tokens [G, app_platform only]
  realm auth_realm · subject_id uuid (employee | membership | platform_user) · tenant_id uuid?
  binding_id uuid? · family_id uuid · parent_id uuid? · token_hash bytea UQ
  expires_at · absolute_expires_at? · used_at? · revoked_at? · revoke_reason text?
  impersonation_session_id uuid? · ip inet? · user_agent text?
  IX(family_id) · IX(realm, subject_id) WHERE revoked_at IS NULL · IX(binding_id)

impersonation_sessions [G]
  platform_user_id → platform_users · tenant_id → tenants · mode text CK IN (READ_ONLY, READ_WRITE)
  reason text CK char_length ≥ 10 · ticket_ref text? · started_at · expires_at · ended_at? · ip inet · user_agent text
  IX(tenant_id, started_at DESC) · IX(platform_user_id, started_at DESC)
```

## 5. Organisation and sites

```
branches [T]
  name text · code text? · state_code char(2) (required; also the future FULL PT/LWF jurisdiction) · address jsonb?
  holiday_calendar_id → holiday_calendars ? · weekly_off_pattern_id → weekly_off_patterns ?
  default_shift_id → shifts ? · active bool =true
  UQ(tenant_id, name) · PUQ(tenant_id, code) WHERE code IS NOT NULL

departments [T]
  name text · code text? · parent_id → departments ? · active bool =true
  UQ(tenant_id, name)

sites [T]                                              -- circle geofence
  branch_id → branches ? · name text · address text?
  lat double CK -90..90 · lng double CK -180..180 · radius_m int CK 20..2000 (default from settings)
  max_accuracy_m int · accuracy_buffer_cap_m int · active bool =true
  UQ(tenant_id, name) · IX(tenant_id, branch_id)

employee_sites [T, PK(tenant_id, employee_id, site_id)]
  employee_id → employees · site_id → sites · IX(tenant_id, site_id)
```

## 6. Employees and imports

```
employees [T]
  employee_code text? · full_name text · phone_e164 text CK '^\+[1-9][0-9]{7,14}$' · email citext?
  gender gender? · designation text? · branch_id → branches · department_id → departments ?
  date_of_joining date · exit_date date? · exit_reason text?
  status employee_status ='INVITED' · geofence_mode geofence_mode ='ASSIGNED_SITES'
  weekly_off_pattern_id → weekly_off_patterns ? (else branch) · policy_id → attendance_policies ? (else shift → tenant)
  created_via text CK IN (SINGLE, IMPORT) · import_row_id uuid? · activated_at? · deactivated_at? · erased_at?
  UQ (phone_e164) WHERE status IN ('INVITED','ACTIVE')     ← GLOBAL, deliberately not tenant-scoped
  PUQ(tenant_id, employee_code) WHERE employee_code IS NOT NULL AND status <> 'EXITED'
  IX(tenant_id, status, branch_id, department_id) · IX(tenant_id, phone_e164)
  GIN(full_name gin_trgm_ops) · GIN(employee_code gin_trgm_ops)
```
Phone rules:
- One live employment per phone across the platform; the unique index is enforced physically, regardless of RLS.
- Moving to DEACTIVATED/EXITED releases the number: bindings REVOKED, codes REVOKED, refresh tokens revoked.
- Create, reactivate or phone change against a held number fails with `PHONE_UNAVAILABLE` (no tenant revealed).
- Rehire = new employee row. Support can force-release (audited).
- PAN/UAN/ESIC/bank are **not** stored in BASIC (§11 placeholder).

```
employee_imports [T]
  uploaded_by → tenant_memberships · source_file_id → stored_files · template_version smallint
  status text CK IN (UPLOADED, VALIDATING, VALIDATED, COMMITTING, COMMITTED, FAILED, CANCELLED)
  options jsonb (mode CREATE_ONLY | UPSERT_BY_CODE) · total_rows · valid_rows · warning_rows · error_rows · committed_rows int =0
  errors_file_id → stored_files ? · validated_at? · committed_at? · failure text?
  IX(tenant_id, created_at DESC)

employee_import_rows [T]                               -- PII; purged 30 d after commit/cancel
  import_id → employee_imports · row_no int · raw jsonb · normalized jsonb?
  status text CK IN (VALID, WARNING, ERROR, COMMITTED, SKIPPED) · errors jsonb ='[]' · employee_id → employees ?
  UQ(tenant_id, import_id, row_no) · IX(tenant_id, import_id, status)
```

## 7. Shifts, policies, calendars, leave

```
attendance_policies [T]
  name text · version int =1 (bumped on every edit; copied to attendance_days)
  hours_mode hours_mode ='FIRST_IN_LAST_OUT'
  late_grace_min smallint =10 · early_leave_grace_min smallint =10
  full_day_min_minutes int? (null = shift duty) · half_day_min_minutes int =240
  missing_out_treatment missing_out_treatment ='ABSENT' · missing_out_reminder_min smallint =30
  min_punch_gap_sec int =60 · block_mock_location bool =true · max_clock_skew_flag_sec int =300
  ot_min_minutes smallint =30 · ot_rounding_minutes smallint =15 · ot_daily_cap_minutes smallint =240
  ot_requires_approval bool =true · sandwich_rule bool =false · active bool =true
  UQ(tenant_id, name)

shifts [T]
  name text · code text? · start_time time · end_time time
  crosses_midnight bool GENERATED ALWAYS AS (end_time <= start_time) STORED
  duty_minutes int CK 60..1440 · unpaid_break_minutes int =0 · is_flexible bool =false
  window_before_start_min int =120 CK 0..720 · window_after_end_min int =360 CK 0..720
  policy_id → attendance_policies ? · color text? · active bool =true
  UQ(tenant_id, name)

shift_assignments [T]
  employee_id → employees · shift_id → shifts · effective_from date · effective_to date? · created_by uuid
  EXCLUDE USING gist (tenant_id WITH =, employee_id WITH =, daterange(effective_from, effective_to, '[]') WITH &&)
  IX(tenant_id, shift_id)

weekly_off_patterns [T]
  name text · rules jsonb  -- [{"dow":7,"weeks":"ALL"},{"dow":6,"weeks":[2,4]}]
  active bool · UQ(tenant_id, name)

holiday_calendars [T]
  name text · is_default bool =false · source_template text?
  UQ(tenant_id, name) · PUQ(tenant_id) WHERE is_default

holidays [T]
  calendar_id → holiday_calendars · holiday_date date · name text
  kind text CK IN (NATIONAL, FESTIVAL, COMPANY, OPTIONAL) · is_paid bool =true
  UQ(tenant_id, calendar_id, holiday_date) · IX(tenant_id, holiday_date)

employee_day_overrides [T]
  employee_id → employees · override_date date · day_type day_type? (null = keep)
  allow_punch bool =true · treat_work_as work_treatment ='NORMAL' · shift_id → shifts ? (roster swap)
  reason text CK char_length ≥ 5 · created_by → tenant_memberships · revoked_at? · revoked_by uuid?
  PUQ(tenant_id, employee_id, override_date) WHERE revoked_at IS NULL · IX(tenant_id, override_date)
  Trigger: assert_month_open(tenant_id, override_date) on INSERT/UPDATE.

leave_types [T]                                        -- used by manual marks even when LEAVE feature off
  code text · name text · is_paid bool · allow_half_day bool =true · active bool =true
  accrual_mode accrual_mode ='NONE' · annual_quota numeric(6,2)? · monthly_accrual numeric(6,2)?
  carry_forward_cap numeric(6,2)? (null = unlimited) · max_negative_balance numeric(6,2) =0
  prorate_on_joining bool =true · count_non_working_days bool =false · backdate_limit_days smallint =7
  attachment_after_days smallint? · encashable bool =false · applicable_gender gender?
  UQ(tenant_id, code) · CK(accrual_mode <> 'FIXED_QUOTA' OR carry_forward_cap = 0)

leave_requests [T]
  employee_id → employees · leave_type_id → leave_types
  from_date date · from_part day_part · to_date date · to_part day_part · days numeric(6,2)
  reason text · attachment_file_id → stored_files ? · status leave_request_status ='PENDING'
  applied_by_actor actor_type · applied_by_id uuid · decided_by → tenant_memberships ? · decided_at?
  decision_note text? · cancelled_by_actor actor_type? · cancelled_at?
  CK(to_date >= from_date) · IX(tenant_id, employee_id, from_date) · IX(tenant_id, status, from_date)
  Overlap guard: per-employee advisory lock + query. Decision/cancel blocked if range touches a LOCKED month.

leave_ledger [T][A]                                    -- source of truth for balances
  employee_id → employees · leave_type_id → leave_types · leave_year smallint
  entry_type leave_entry_type · days numeric(6,2) (signed) · period_key text? ('2026-11' | '2026')
  leave_request_id → leave_requests ? · reason text? · actor_type actor_type · actor_id uuid?
  PUQ(tenant_id, employee_id, leave_type_id, entry_type, period_key)
      WHERE entry_type IN ('OPENING','ACCRUAL','CARRY_FORWARD','LAPSE')   ← idempotent jobs
  IX(tenant_id, employee_id, leave_type_id, leave_year)

leave_balances [T]                                     -- cache; updated in same tx as ledger; rebuildable
  employee_id → employees · leave_type_id → leave_types · leave_year smallint
  opening · accrued · carried_in · used · credited · adjusted · lapsed · encashed · balance numeric(6,2)
  pending numeric(6,2) =0
  UQ(tenant_id, employee_id, leave_type_id, leave_year)
```

## 8. Punches and attendance

```
punches [T][A][P server_time]   PK(id, server_time); id = intent id (UUIDv7)
  employee_id → employees · binding_id → device_bindings ? (null for EMPLOYER source)
  attendance_date date · sequence_no smallint · direction punch_direction (inferred)
  server_time timestamptz · device_time timestamptz? · clock_skew_sec int?
  source punch_source ='APP' · created_by → tenant_memberships ? · reason text? (required for EMPLOYER)
  lat double? · lng double? · accuracy_m real? · is_mock bool? · site_id → sites ? · distance_m real?
  selfie_key text? · selfie_sha256 bytea? · thumb_key text? · selfie_purged_at?
  liveness jsonb? · integrity jsonb? · integrity_flags text[] ='{}' · app_version text?
  voided_at? · voided_by → tenant_memberships ? · void_reason text?
  IX(tenant_id, employee_id, attendance_date) · IX(tenant_id, server_time DESC) (live feed)
  IX(tenant_id, attendance_date, site_id) (map) · IX(tenant_id, server_time) WHERE selfie_key IS NOT NULL (purge)
  Triggers: EMPLOYER insert + void → assert_month_open(tenant_id, attendance_date).

punch_rejections [T][A][P attempted_at]   PK(id, attempted_at); 3-month retention
  employee_id → employees · binding_id uuid? · attempted_at · stage text CK IN (INTENT, COMMIT)
  reason_code reject_reason · lat double? · lng double? · accuracy_m real? · is_mock bool?
  nearest_site_id uuid? · distance_m real? · details jsonb?
  IX(tenant_id, attempted_at DESC) · IX(tenant_id, employee_id, attempted_at DESC)

attendance_days [T]                                    -- DERIVED; written only by AttendanceDayWriter
  employee_id → employees · attendance_date date · branch_id uuid · department_id uuid? (snapshot for scoping)
  day_type day_type · holiday_id → holidays ? · holiday_paid bool? · override_id → employee_day_overrides ?
  shift_id → shifts ? · policy_id → attendance_policies ? · policy_version int?
  expected_start_at? · expected_end_at? · window_end_at? (UTC)
  punch_count smallint =0 · first_punch_at? · last_punch_at? · worked_minutes int =0
  late_minutes int =0 · early_leave_minutes int =0 · is_late bool =false · is_missing_out bool =false
  ot_minutes int =0 · ot_state ot_state ='NOT_APPLICABLE' · ot_approved_minutes int =0
  ot_decided_by → tenant_memberships ? · ot_decided_at?
  leave_request_id → leave_requests ? · leave_type_id → leave_types ? · leave_fraction numeric(3,2) =0 · leave_paid bool?
  computed_status attendance_status · final_status attendance_status
  status_source text CK IN (COMPUTED, MANUAL) · manual_mark_id → attendance_manual_marks ?
  paid_fraction numeric(3,2) · lop_fraction numeric(3,2) · flags text[] ='{}'
  is_finalized bool =false · finalized_at? · period_locked bool =false · missing_out_reminded_at?
  inputs_hash bytea · engine_version text · computed_at
  UQ(tenant_id, employee_id, attendance_date)
  IX(tenant_id, attendance_date, final_status) · IX(tenant_id, attendance_date, branch_id)
  IX(window_end_at) WHERE is_finalized = false                                  (tick: finalize)
  IX(expected_end_at) WHERE is_missing_out AND missing_out_reminded_at IS NULL AND NOT is_finalized   (reminders)
  IX(tenant_id, ot_state) WHERE ot_state = 'PENDING'
  Trigger: UPDATE rejected while period_locked (except by the lock/unlock job, which sets a session flag).

attendance_manual_marks [T][A]
  employee_id → employees · attendance_date date · action mark_action
  status attendance_status? (PRESENT | ABSENT | HALF_DAY | LEAVE | ON_DUTY | WEEKLY_OFF | HOLIDAY)
  leave_type_id → leave_types ? · worked_minutes_override int?
  reason text CK char_length(reason) ≥ 5 · previous_final_status attendance_status
  marked_by → tenant_memberships · impersonation_session_id uuid?
  CK(action = 'REVOKE' OR status IS NOT NULL) · CK(status <> 'LEAVE' OR leave_type_id IS NOT NULL)
  IX(tenant_id, employee_id, attendance_date, created_at DESC)
  Effective mark = latest row per (employee, date); REVOKE → none. LEAVE marks rejected when feature LEAVE on.
  Trigger: assert_month_open(tenant_id, attendance_date).
```

## 9. Pay monitoring (payroll tier BASIC)

```
employee_salary_assignments [T]                        -- effective-dated; revisions = new rows (history)
  employee_id → employees · salary_basis salary_basis · pay_frequency pay_frequency
  monthly_salary numeric(14,2)? · weekly_rate numeric(14,2)? · hourly_rate numeric(14,2)?
  effective_from date · effective_to date? · ot_multiplier numeric(4,2)? (null = no OT premium)
  revision_reason text CK char_length ≥ 3 · created_by → tenant_memberships
  EXCLUDE USING gist (tenant_id WITH =, employee_id WITH =, daterange(effective_from, effective_to, '[]') WITH &&)
  CK((salary_basis='MONTHLY' AND monthly_salary > 0 AND pay_frequency='MONTHLY')
  OR (salary_basis='WEEKLY'  AND weekly_rate > 0    AND pay_frequency='WEEKLY')
  OR (salary_basis='HOURLY'  AND hourly_rate > 0))
  IX(tenant_id, employee_id, effective_from DESC)
  Triggers: INSERT requires effective_from ≥ first OPEN month; UPDATE/DELETE rejected if the range
            intersects a LOCKED month (closing effective_to inside an open month is allowed).

pay_periods [T]                                        -- one per tenant per calendar month
  month date (first of month) · status pay_status ='OPEN'
  locked_at? · locked_by → tenant_memberships ? · lock_warnings jsonb? (acknowledged at lock)
  unlock_count smallint =0 · last_unlock_reason text? · totals jsonb ='{}' (frozen at lock)
  UQ(tenant_id, month)

employee_pay_summaries [T]                             -- DERIVED by pay-engine; one per employee per pay period
  employee_id → employees · pay_period_id → pay_periods (month of period_end)
  frequency pay_frequency · period_start date · period_end date · salary_basis salary_basis
  divisor_mode text · divisor numeric(6,2) · period_days smallint · employed_days numeric(6,2) · entitled_days numeric(6,2)
  present_days · half_days · paid_holiday_days · weekly_off_days · paid_leave_days
  unpaid_leave_days · absent_days · unpaid_other_days · lop_days · payable_days numeric(6,2)
  worked_minutes int · regular_minutes int · ot_approved_minutes int
  segments jsonb ([{from, to, assignment_id, rate, entitled, lop, payable, base}])
  base_earned · ot_earned · additions · deductions · net_earned numeric(14,2)
  mtd_through date? · projected_net numeric(14,2)? (OPEN only)
  flags text[] ='{}' (NEGATIVE_NET, NO_SALARY, UNFINALIZED_DAYS, PENDING_LEAVE, PENDING_OT)
  status pay_status ='OPEN' · snapshot jsonb? (frozen inputs + outputs at lock → FULL seam)
  inputs_hash bytea · engine_version text · computed_at
  UQ(tenant_id, employee_id, frequency, period_start)
  IX(tenant_id, pay_period_id, status) · IX(tenant_id, employee_id, period_start DESC)
  Trigger: rows with status='LOCKED' accept only the transition to OPEN (unlock job).

pay_adjustments [T][A]                                 -- manual one-off additions/deductions
  employee_id → employees · pay_period_id → pay_periods · period_start date (target pay period)
  direction text CK IN (ADDITION, DEDUCTION)
  category text CK IN (BONUS, INCENTIVE, ARREAR, REIMBURSEMENT, ADVANCE, RECOVERY, OTHER)
  amount numeric(14,2) CK > 0 · reason text CK char_length ≥ 5 · relates_to_month date?
  created_by → tenant_memberships · impersonation_session_id uuid?
  voided_at? · voided_by → tenant_memberships ? · void_reason text?
  Column UPDATE grant: voided_at, voided_by, void_reason only.
  IX(tenant_id, pay_period_id, employee_id)
  Trigger: INSERT/void rejected when target pay_period LOCKED. Service writes audit_logs in same tx.
```
Formulas: `architecture.md` §12.3. With CALENDAR_DAYS for a full month, `payable_days = present + 0.5·half + paid holidays + weekly offs + paid leave`.

## 10. Files, exports, notifications, outbox

```
stored_files [T]                                       -- registry for non-selfie objects
  bucket text · object_key text UQ
  purpose text CK IN (EXPORT, IMPORT_SOURCE, IMPORT_ERRORS, LEAVE_ATTACHMENT, BILLING_INVOICE, DATA_REQUEST)
  mime text · size_bytes bigint · sha256 bytea · created_by_actor actor_type · created_by_id uuid?
  expires_at? · deleted_at?
  IX(tenant_id, purpose, created_at DESC) · IX(expires_at) WHERE deleted_at IS NULL

export_jobs [T]
  requested_by → tenant_memberships
  export_type text (ATTENDANCE_DAILY, ATTENDANCE_REGISTER, PUNCH_LOG, SALARY_REGISTER, PAY_ADJUSTMENTS, LEAVE_BALANCES, EMPLOYEE_MASTER)
  format text CK IN (XLSX, PDF, CSV) · params jsonb (filters + requester scope snapshot) · params_hash bytea
  status job_status ='QUEUED' · progress smallint =0 · file_id → stored_files ? · error text?
  started_at? · finished_at? · expires_at?
  IX(tenant_id, requested_by, created_at DESC)
  PUQ(tenant_id, params_hash) WHERE status IN ('QUEUED','RUNNING')

notifications [T]                                      -- inbox + push log; deleted after 90 d
  recipient_type text CK IN (EMPLOYEE, TENANT_USER) · recipient_id uuid · type text · title text · body text
  data jsonb · push_status text CK IN (NONE, SENT, FAILED) ='NONE' · sent_at? · read_at?
  IX(tenant_id, recipient_type, recipient_id, created_at DESC)

outbox_events [G, app_tenant INSERT only]
  id bigint GENERATED ALWAYS AS IDENTITY PK · tenant_id uuid? · topic text · payload jsonb
  created_at · published_at? · attempts smallint =0
  IX(id) WHERE published_at IS NULL
```

## 11. FULL payroll tier (deferred): placeholder

No DDL now. When FULL is built in-house, or connected to an external provider, these groups are added:

| Group | Purpose (outline) |
|---|---|
| Statutory rule store | rules versioned by rule type × jurisdiction (IN or state/UT) × effective range; JSON params validated per schema version; versioned calculation strategy; immutable after publish. Covers PF, ESI, PT/LWF (all states), TDS (Income-tax Act 2025 from 1 Apr 2026), Labour Code wage rules |
| Tenant statutory setup | registrations (PF/ESI/PT/LWF/TAN) and per-component toggles |
| Employee statutory profile | PAN/UAN/ESIC (encrypted + blind index), per-employee overrides where law allows, bank accounts |
| Salary components/structures | component catalogue, structure templates, formulas |
| Tax declarations | regime choice, declarations, proofs, prior-employer income |
| Payroll runs | runs, run employees (frozen inputs + hash), immutable lines after lock, arrears, payments |
| Outputs | payslips, statutory reports, bank file templates and payout batches |
| External provider link | `external_payroll_links` (tenant, provider, external ids, sync state, last pushed period) |

**Seam (exists now):** FULL reads only LOCKED `employee_pay_summaries.snapshot`, plus `employee_salary_assignments`, `pay_adjustments`, `attendance_days` and `branches.state_code`, through the `PayrollPeriodInput` contract. Nothing in BASIC needs to change.

## 12. Audit and compliance

```
audit_logs [A][P occurred_at]   PK(id, occurred_at)
  tenant_id uuid? (null = platform-level) · occurred_at timestamptz · actor_type actor_type · actor_id uuid?
  impersonation_session_id uuid? · action text · entity_type text · entity_id uuid?
  before jsonb? · after jsonb? (PII redacted; never activation codes) · reason text?
  request_id text? · ip inet? · user_agent text?
  IX(tenant_id, occurred_at DESC) · IX(tenant_id, entity_type, entity_id, occurred_at DESC) · IX(actor_id, occurred_at DESC)
  Action catalogue (excerpt):
    activation_code.{issued, regenerated, bulk_issued, emailed, locked, revoked} · auth.activation.succeeded ·
    auth.pin_reset.{code_issued, succeeded} · auth.refresh_reuse ·
    device.binding.{pending, approved, rejected, released, revoked} ·
    employee.{create, update, deactivate, exit, phone_force_release} ·
    attendance.manual_mark · attendance.punch.{employer_add, void} · attendance.ot.decide ·
    leave.request.{approve, reject, cancel} · leave.balance.adjust ·
    salary.assignment.{create, close} · pay.adjustment.{create, void} · pay.period.{lock, unlock} ·
    tenant.{feature.update, settings.update, suspend, reactivate} · role.update · selfie.view ·
    impersonation.{start, request, end} · billing.charge.{issue, void, attach_invoice} · billing.payment.{record, reverse} ·
    data_request.*

consent_notices [special RLS]                         -- tenant_id null = platform template
  tenant_id uuid? → tenants · audience text CK IN (EMPLOYEE, TENANT_USER) · language text ='en'
  version int · title text · body_md text · purposes jsonb ([{code, label, required}])
  published_at? · retired_at?
  UQ NULLS NOT DISTINCT (tenant_id, audience, language, version)

consent_records [T][A]
  subject_type text CK IN (EMPLOYEE, TENANT_USER) · subject_id uuid · notice_id → consent_notices (simple FK)
  action text CK IN (GRANT, WITHDRAW) · purposes jsonb · method text CK IN (APP, WEB)
  binding_id uuid? · ip inet?
  IX(tenant_id, subject_type, subject_id, created_at DESC)

data_requests [T]
  subject_type text · subject_id uuid · request_type text CK IN (ACCESS, CORRECTION, ERASURE, NOMINATION, GRIEVANCE)
  status text CK IN (OPEN, IN_PROGRESS, COMPLETED, REJECTED) · details text · due_at
  resolved_at? · resolved_by → tenant_memberships ? · resolution_note text? · export_file_id → stored_files ?
  IX(tenant_id, status, due_at)

retention_purge_runs [G]
  job_type text · tenant_id uuid? · cutoff timestamptz · started_at · finished_at?
  objects_deleted int =0 · rows_updated int =0 · status job_status · error text?
```

## 13. Billing (superadmin, manual; provider seam)

```
plans [G-read]
  code text · name text · version int · billing_interval text CK IN (MONTH, YEAR)
  price_per_employee numeric(10,2) (excl. GST) · min_billable_employees int =0 · default_employee_cap int?
  trial_days smallint =14 · trial_employee_cap int =25 · default_payroll_tier text ='BASIC' CK IN (BASIC, FULL)
  features jsonb (feature defaults) · payment_terms_days smallint =15 · is_public bool · active bool
  UQ(code, version)

subscriptions [T-ro]                                   -- one current per tenant
  plan_id → plans · status subscription_status · billing_interval text · billing_mode text ='ARREARS' CK IN (ARREARS, ADVANCE)
  current_period_start date · current_period_end date · next_due_date date? · trial_ends_at?
  seats int? · employee_cap int? · price_override numeric(10,2)? · discount_pct numeric(5,2) =0
  provider text ='MANUAL' · provider_customer_ref text? · provider_subscription_ref text?   -- seam
  suspended_at? · suspend_reason text? · cancel_at_period_end bool =false
  UQ(tenant_id)

subscription_events [T-ro][A]
  subscription_id → subscriptions · event_type text · from_status text? · to_status text?
  payload jsonb · actor_type actor_type · actor_id uuid?
  IX(tenant_id, created_at DESC)

subscription_charges [T-ro]                            -- a due amount for one billing period
  subscription_id → subscriptions · period_start date · period_end date
  billable_employees int · unit_price numeric(10,2) · subtotal numeric(14,2)
  gst_rate numeric(5,2) =18 · gst_amount numeric(14,2) · total numeric(14,2) · amount_paid numeric(14,2) =0
  status charge_status ='DRAFT' · issued_at? · due_date date? · paid_at?
  invoice_no text? · invoice_file_id → stored_files ? (issued from accounting system) · notes text?
  created_by_actor actor_type · created_by_id uuid? · provider_ref text? (seam)
  PUQ(tenant_id, subscription_id, period_start) WHERE status NOT IN ('VOID')
  IX(status, due_date) · IX(tenant_id, period_start DESC)

payments [T-ro]
  charge_id → subscription_charges ? · amount numeric(14,2)
  method text CK IN (BANK_TRANSFER, UPI, CHEQUE, CASH, CARD, OTHER) · reference_no text? (UTR / cheque)
  received_on date · recorded_by → platform_users · notes text? · status text ='RECORDED' CK IN (RECORDED, REVERSED)
  provider text ='MANUAL' · provider_payment_ref text? UQ (seam)
  IX(tenant_id, received_on DESC)

usage_daily_snapshots [T-ro, PK(tenant_id, snapshot_date)]
  snapshot_date date · active_employees int · invited_employees int · punches int · web_users int · storage_bytes bigint
```
- The `overdue-check` job flips DUE → OVERDUE after `due_date` and the subscription → PAST_DUE. Suspension is a manual superadmin action (optional auto-suspend setting).
- A payment provider later adds an adapter + a provider-events table; charge and payment semantics stay unchanged.

## 14. Append-only and immutability summary

| Table | Rule | Allowed mutations |
|---|---|---|
| punches | [A] | column grants: selfie purge fields, integrity_flags, void fields (void blocked in locked months) |
| punch_rejections, audit_logs | [A] | none (partition drop for retention) |
| attendance_manual_marks | [A] | none; revoke = new REVOKE row; blocked in locked months |
| leave_ledger | [A] | none; corrections = ADJUSTMENT rows |
| pay_adjustments | [A] | void columns only; blocked when target period LOCKED |
| consent_records, subscription_events | [A] | none |
| activation_codes | state machine | ISSUED → USED / LOCKED / REVOKED / EXPIRED only (trigger); code_hmac never updated |
| device_bindings | state machine | PENDING → ACTIVE / REVOKED; ACTIVE → REVOKED; key columns immutable |
| employee_salary_assignments | locked-month guard | no change intersecting a LOCKED month; revisions = new rows |
| employee_pay_summaries | LOCKED rows frozen | only LOCKED → OPEN via unlock job |
| attendance_days | `period_locked` | only lock/unlock job |
| pay_periods | state machine | OPEN ⇄ LOCKED via lock/unlock services (audited) |

## 15. Derived data: recompute contract

**Attendance days**
- **Single writer.** `AttendanceDayWriter.recompute(tenantId, employeeId, dates[])` is the only code path that writes `attendance_days` (module-private repository + lint rule).
- **Per date:**
  1. Load inputs: non-voided punches; shift (override shift ?? assignment); policy + version; day type (override > holiday via branch calendar ?? tenant default > weekly-off pattern, employee ?? branch); approved leave; latest manual mark; features.
  2. `inputs_hash = sha256(canonical json + ENGINE_VERSION)`. If it equals the stored hash, no-op.
  3. Otherwise `computeDay()` and UPSERT on `(tenant_id, employee_id, attendance_date)`.
  4. If `paid_fraction`, `lop_fraction`, `worked_minutes` or `ot_approved_minutes` changed, emit outbox `pay.recompute` for the employee's pay period.
- **Triggers:**

| Event | Scope |
|---|---|
| punch insert / void, manual mark, day override, OT decision | one day |
| leave approve / cancel | request date range |
| shift assignment, employee branch/policy/weekly-off change | from effective date to today |
| policy edit (version++), holiday / calendar / weekly-off edit, OVERTIME toggle | affected employees, from change date, open months only |

- **Scheduled:**
  - `day-open` (00:05 tenant TZ) pre-creates rows for ACTIVE employees.
  - `tick` (5 min) finalizes rows past `window_end_at`.
  - `nightly-reconcile` recomputes yesterday for everyone (hash-skips no-ops) to heal missed events.

**Pay summaries**
- **Single writer.** `PaySummaryWriter.recompute(tenantId, employeeId, periodStart)`: OPEN rows only (a LOCKED row means the write is a no-op + alert).
- **Inputs:** finalized attendance days in the period, salary assignments clipped to the period, non-voided adjustments, `pay_divisor`, `net_pay_rounding`, OVERTIME feature, DOJ/exit. Hash + `PAY_ENGINE_VERSION`; skip if unchanged.
- **Triggers:** `pay.recompute` from attendance; salary assignment create/close; adjustment create/void; divisor/rounding change (all OPEN periods); employee exit/DOJ change; the nightly reconcile after attendance.
- **Lock:** `pay.lock-month` recomputes every summary in the month, writes `snapshot`, sets LOCKED, freezes `pay_periods.totals`, and sets `attendance_days.period_locked` for the month. Unlock reverses this (Admin, reason, audited) and enqueues a recompute.

## 16. Partitioning and retention

| Object | Partitioning | Retention | Mechanism |
|---|---|---|---|
| punches | monthly on server_time | 36 months (platform max) | detach + drop partition |
| punch_rejections | monthly on attempted_at | 3 months | drop partition |
| audit_logs | monthly on occurred_at | 8 years | detach >24 months → archive gz JSONL → drop |
| selfie + activation-selfie objects | none | `selfie_retention_days` (default 90) | purge job deletes objects, sets `selfie_purged_at`, nulls keys |
| employee_import_rows | none | 30 d after commit/cancel | batch delete (platform role) |
| notifications | none | 90 d | batch delete |
| refresh_tokens | none | 30 d after expiry/revoke | batch delete |
| exports | none | 7 d | bucket lifecycle + row EXPIRED |
| pay data (summaries, adjustments, assignments) | none | 8 years (configurable) | anonymize employee identity after |
| exited-employee personal data | none | `exited_purge_days` after exit | erasure: selfies, binding metadata, contact fields redacted; pay records kept until pay retention |

- **Partition maintenance** (monthly, owner role): create the next 3 monthly partitions plus a DEFAULT partition (alert if non-empty).
- **Partitioned tables** need a composite PK `(id, <partition col>)`. Nothing has an FK into them; references are logical.

## 17. Key query paths ↔ indexes

| Path | Index |
|---|---|
| Activation: phone → live employee (cross-tenant, platform role) | `employees (phone_e164) WHERE status IN ('INVITED','ACTIVE')` |
| Live code for employee | `activation_codes PUQ(tenant_id, employee_id, purpose) WHERE status='ISSUED'` |
| Per-request binding check (cache miss) | `device_bindings` PK + `PUQ(tenant_id, employee_id) WHERE status IN (PENDING, ACTIVE)` |
| Pending device approvals | `device_bindings IX(tenant_id, status, created_at DESC)` |
| Today dashboard counts by scope | `attendance_days IX(tenant_id, attendance_date, branch_id)` + `IX(tenant_id, attendance_date, final_status)` |
| Live feed (keyset) | `punches IX(tenant_id, server_time DESC)` (partition-pruned) |
| Employee day detail / recompute load | `punches IX(tenant_id, employee_id, attendance_date)` |
| Map view for a date | `punches IX(tenant_id, attendance_date, site_id)` |
| Employee search | trigram GIN on full_name, employee_code; btree on phone |
| Pay live grid / salary register for a month | `employee_pay_summaries IX(tenant_id, pay_period_id, status)` |
| Employee pay history / app earnings | `employee_pay_summaries IX(tenant_id, employee_id, period_start DESC)` |
| Salary on a date | `employee_salary_assignments IX(tenant_id, employee_id, effective_from DESC)` + exclusion constraint |
| Adjustments for a period | `pay_adjustments IX(tenant_id, pay_period_id, employee_id)` |
| Month lock state check (triggers) | `pay_periods UQ(tenant_id, month)` |
| Pending leave approvals / balances | `leave_requests IX(tenant_id, status, from_date)` · `leave_balances UQ(...)` |
| Overdue charges | `subscription_charges IX(status, due_date)` |
| Finalize / reminders tick | partial indexes on `attendance_days(window_end_at)` / `(expected_end_at)` |
| Outbox relay | `outbox_events IX(id) WHERE published_at IS NULL` |
