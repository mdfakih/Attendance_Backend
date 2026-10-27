-- CreateEnum
CREATE TYPE "TenantStatus" AS ENUM ('TRIAL', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PayrollTier" AS ENUM ('BASIC', 'FULL');

-- CreateEnum
CREATE TYPE "PlatformRole" AS ENUM ('SUPERADMIN', 'SUPPORT', 'FINANCE', 'READONLY');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "RoleKind" AS ENUM ('ADMIN', 'MANAGER');

-- CreateEnum
CREATE TYPE "EmployeeStatus" AS ENUM ('INVITED', 'ACTIVE', 'DEACTIVATED', 'EXITED');

-- CreateEnum
CREATE TYPE "BindingStatus" AS ENUM ('PENDING', 'ACTIVE', 'REVOKED');

-- CreateEnum
CREATE TYPE "CodePurpose" AS ENUM ('ACTIVATION', 'PIN_RESET');

-- CreateEnum
CREATE TYPE "CodeStatus" AS ENUM ('ISSUED', 'USED', 'LOCKED', 'REVOKED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "AuthRealm" AS ENUM ('EMPLOYEE', 'TENANT_USER', 'PLATFORM_USER');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('EMPLOYEE', 'TENANT_USER', 'PLATFORM_USER', 'SYSTEM');

-- CreateEnum
CREATE TYPE "GeofenceMode" AS ENUM ('ASSIGNED_SITES', 'ANY_TENANT_SITE');

-- CreateEnum
CREATE TYPE "HoursMode" AS ENUM ('FIRST_IN_LAST_OUT', 'SUM_OF_PAIRS');

-- CreateEnum
CREATE TYPE "MissingOutTreatment" AS ENUM ('ABSENT', 'HALF_DAY', 'PRESENT_FLAGGED');

-- CreateEnum
CREATE TYPE "DayType" AS ENUM ('WORKING', 'WEEKLY_OFF', 'HOLIDAY');

-- CreateEnum
CREATE TYPE "AttendanceStatus" AS ENUM ('NOT_STARTED', 'IN_PROGRESS', 'PRESENT', 'HALF_DAY', 'ABSENT', 'MISSING_OUT', 'LEAVE', 'HALF_LEAVE', 'HOLIDAY', 'WEEKLY_OFF');

-- CreateEnum
CREATE TYPE "PunchDirection" AS ENUM ('IN', 'OUT');

-- CreateEnum
CREATE TYPE "PunchSource" AS ENUM ('APP', 'EMPLOYER');

-- CreateEnum
CREATE TYPE "OtState" AS ENUM ('NOT_APPLICABLE', 'PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "MarkAction" AS ENUM ('SET', 'REVOKE');

-- CreateEnum
CREATE TYPE "AccrualMode" AS ENUM ('NONE', 'FIXED_QUOTA', 'YEARLY_ACCRUAL', 'MONTHLY_ACCRUAL');

-- CreateEnum
CREATE TYPE "DayPart" AS ENUM ('FULL', 'FIRST_HALF', 'SECOND_HALF');

-- CreateEnum
CREATE TYPE "LeaveRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "LeaveEntryType" AS ENUM ('OPENING', 'ACCRUAL', 'CARRY_FORWARD', 'LAPSE', 'DEBIT', 'CREDIT', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "SalaryBasis" AS ENUM ('MONTHLY', 'WEEKLY', 'HOURLY');

-- CreateEnum
CREATE TYPE "PayStatus" AS ENUM ('OPEN', 'LOCKED');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('TRIALING', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ChargeStatus" AS ENUM ('DRAFT', 'DUE', 'PAID', 'OVERDUE', 'VOID');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('QUEUED', 'RUNNING', 'DONE', 'FAILED', 'EXPIRED');

-- CreateTable
CREATE TABLE "punches" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "binding_id" UUID,
    "attendance_date" DATE NOT NULL,
    "sequence_no" INTEGER NOT NULL,
    "direction" "PunchDirection" NOT NULL,
    "server_time" TIMESTAMPTZ NOT NULL,
    "device_time" TIMESTAMPTZ,
    "clock_skew_sec" INTEGER,
    "source" "PunchSource" NOT NULL DEFAULT 'APP',
    "created_by_id" UUID,
    "reason" TEXT,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "accuracy_m" DOUBLE PRECISION,
    "is_mock" BOOLEAN,
    "site_id" UUID,
    "distance_m" DOUBLE PRECISION,
    "selfie_key" TEXT,
    "selfie_sha256" TEXT,
    "thumb_key" TEXT,
    "selfie_purged_at" TIMESTAMPTZ,
    "liveness" JSONB,
    "flags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "app_version" TEXT,
    "voided_at" TIMESTAMPTZ,
    "voided_by_id" UUID,
    "void_reason" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "punches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "punch_rejections" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "binding_id" UUID,
    "attempted_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "stage" TEXT NOT NULL,
    "reason_code" TEXT NOT NULL,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "accuracy_m" DOUBLE PRECISION,
    "is_mock" BOOLEAN,
    "nearest_site_id" UUID,
    "distance_m" DOUBLE PRECISION,
    "details" JSONB,

    CONSTRAINT "punch_rejections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_days" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "attendance_date" DATE NOT NULL,
    "branch_id" UUID NOT NULL,
    "department_id" UUID,
    "day_type" "DayType" NOT NULL,
    "holiday_id" UUID,
    "holiday_paid" BOOLEAN NOT NULL DEFAULT true,
    "override_id" UUID,
    "shift_id" UUID,
    "policy_id" UUID,
    "policy_version" INTEGER,
    "expected_start_at" TIMESTAMPTZ,
    "expected_end_at" TIMESTAMPTZ,
    "window_end_at" TIMESTAMPTZ,
    "duty_minutes" INTEGER NOT NULL DEFAULT 0,
    "punch_count" INTEGER NOT NULL DEFAULT 0,
    "first_punch_at" TIMESTAMPTZ,
    "last_punch_at" TIMESTAMPTZ,
    "worked_minutes" INTEGER NOT NULL DEFAULT 0,
    "late_minutes" INTEGER NOT NULL DEFAULT 0,
    "early_leave_minutes" INTEGER NOT NULL DEFAULT 0,
    "is_late" BOOLEAN NOT NULL DEFAULT false,
    "is_missing_out" BOOLEAN NOT NULL DEFAULT false,
    "ot_minutes" INTEGER NOT NULL DEFAULT 0,
    "ot_state" "OtState" NOT NULL DEFAULT 'NOT_APPLICABLE',
    "ot_approved_minutes" INTEGER NOT NULL DEFAULT 0,
    "ot_decided_by_id" UUID,
    "ot_decided_at" TIMESTAMPTZ,
    "leave_request_id" UUID,
    "leave_type_id" UUID,
    "leave_fraction" DECIMAL(3,2) NOT NULL DEFAULT 0,
    "leave_paid" BOOLEAN NOT NULL DEFAULT true,
    "computed_status" "AttendanceStatus" NOT NULL,
    "final_status" "AttendanceStatus" NOT NULL,
    "status_source" TEXT NOT NULL DEFAULT 'COMPUTED',
    "manual_mark_id" UUID,
    "paid_fraction" DECIMAL(3,2) NOT NULL DEFAULT 0,
    "lop_fraction" DECIMAL(3,2) NOT NULL DEFAULT 0,
    "flags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "is_finalized" BOOLEAN NOT NULL DEFAULT false,
    "finalized_at" TIMESTAMPTZ,
    "period_locked" BOOLEAN NOT NULL DEFAULT false,
    "missing_out_reminded_at" TIMESTAMPTZ,
    "inputs_hash" TEXT NOT NULL,
    "engine_version" TEXT NOT NULL,
    "computed_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "attendance_days_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_manual_marks" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "attendance_date" DATE NOT NULL,
    "action" "MarkAction" NOT NULL,
    "status" "AttendanceStatus",
    "leave_type_id" UUID,
    "reason" TEXT NOT NULL,
    "previous_final_status" "AttendanceStatus",
    "marked_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attendance_manual_marks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "phone_e164" TEXT,
    "password_hash" TEXT,
    "mfa_secret_enc" TEXT,
    "mfa_enabled" BOOLEAN NOT NULL DEFAULT false,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "failed_logins" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ,
    "password_changed_at" TIMESTAMPTZ,
    "last_login_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "RoleKind" NOT NULL,
    "description" TEXT,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "permissions" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_memberships" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "perm_version" INTEGER NOT NULL DEFAULT 1,
    "branch_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "department_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "last_active_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "tenant_memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_invitations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "role_id" UUID NOT NULL,
    "branch_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "department_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "token_hash" TEXT NOT NULL,
    "invited_by_id" UUID,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "accepted_at" TIMESTAMPTZ,
    "revoked_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "password_reset_tokens" (
    "id" UUID NOT NULL,
    "realm" "AuthRealm" NOT NULL,
    "subject_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "used_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL,
    "realm" "AuthRealm" NOT NULL,
    "subject_id" UUID NOT NULL,
    "tenant_id" UUID,
    "binding_id" UUID,
    "family_id" UUID NOT NULL,
    "parent_id" UUID,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "absolute_expires_at" TIMESTAMPTZ,
    "used_at" TIMESTAMPTZ,
    "revoked_at" TIMESTAMPTZ,
    "revoke_reason" TEXT,
    "ip" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "activation_codes" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "purpose" "CodePurpose" NOT NULL,
    "code_hmac" TEXT NOT NULL,
    "code_enc" TEXT,
    "pepper_version" INTEGER NOT NULL,
    "status" "CodeStatus" NOT NULL DEFAULT 'ISSUED',
    "failed_attempts" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "issued_via" TEXT NOT NULL,
    "issued_by_actor" "ActorType" NOT NULL,
    "issued_by_id" UUID,
    "used_at" TIMESTAMPTZ,
    "used_by_binding_id" UUID,
    "locked_at" TIMESTAMPTZ,
    "revoked_at" TIMESTAMPTZ,
    "live_key" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "activation_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_bindings" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "activation_code_id" UUID,
    "install_id" UUID NOT NULL,
    "platform" TEXT NOT NULL DEFAULT 'ANDROID',
    "public_key_spki" TEXT NOT NULL,
    "key_fingerprint" TEXT NOT NULL,
    "key_alg" TEXT NOT NULL DEFAULT 'ES256',
    "android_id_hmac" TEXT,
    "manufacturer" TEXT NOT NULL DEFAULT '',
    "model" TEXT NOT NULL DEFAULT '',
    "os_version" TEXT NOT NULL DEFAULT '',
    "app_version" TEXT NOT NULL DEFAULT '',
    "fcm_token" TEXT,
    "fcm_token_updated_at" TIMESTAMPTZ,
    "status" "BindingStatus" NOT NULL,
    "activation_selfie_key" TEXT,
    "approved_by_id" UUID,
    "approved_at" TIMESTAMPTZ,
    "activated_at" TIMESTAMPTZ,
    "last_seen_at" TIMESTAMPTZ,
    "revoked_at" TIMESTAMPTZ,
    "revoke_reason" TEXT,
    "revoked_by_actor" "ActorType",
    "revoked_by_id" UUID,
    "revoke_note" TEXT,
    "live_employee_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "device_bindings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "branches" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "state_code" CHAR(2) NOT NULL,
    "address" TEXT,
    "holiday_calendar_id" UUID,
    "weekly_off_pattern_id" UUID,
    "default_shift_id" UUID,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "branches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "departments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "departments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sites" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "radius_m" INTEGER NOT NULL,
    "max_accuracy_m" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "sites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_sites" (
    "tenant_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_sites_pkey" PRIMARY KEY ("employee_id","site_id")
);

-- CreateTable
CREATE TABLE "employees" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "employee_code" TEXT,
    "full_name" TEXT NOT NULL,
    "phone_e164" TEXT NOT NULL,
    "email" TEXT,
    "designation" TEXT,
    "branch_id" UUID NOT NULL,
    "department_id" UUID,
    "date_of_joining" DATE NOT NULL,
    "exit_date" DATE,
    "exit_reason" TEXT,
    "status" "EmployeeStatus" NOT NULL DEFAULT 'INVITED',
    "geofence_mode" "GeofenceMode" NOT NULL DEFAULT 'ASSIGNED_SITES',
    "weekly_off_pattern_id" UUID,
    "policy_id" UUID,
    "duty_minutes" INTEGER,
    "created_via" TEXT NOT NULL DEFAULT 'SINGLE',
    "live_phone" TEXT,
    "live_code_key" TEXT,
    "activated_at" TIMESTAMPTZ,
    "deactivated_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "employees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_imports" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "uploaded_by_id" UUID NOT NULL,
    "file_name" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "total_rows" INTEGER NOT NULL DEFAULT 0,
    "valid_rows" INTEGER NOT NULL DEFAULT 0,
    "error_rows" INTEGER NOT NULL DEFAULT 0,
    "committed_rows" INTEGER NOT NULL DEFAULT 0,
    "validated_at" TIMESTAMPTZ,
    "committed_at" TIMESTAMPTZ,
    "failure" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "employee_imports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_import_rows" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "import_id" UUID NOT NULL,
    "row_no" INTEGER NOT NULL,
    "raw" JSONB NOT NULL,
    "normalized" JSONB,
    "status" TEXT NOT NULL,
    "errors" JSONB NOT NULL DEFAULT '[]',
    "employee_id" UUID,

    CONSTRAINT "employee_import_rows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_salary_assignments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "salary_basis" "SalaryBasis" NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "ot_multiplier" DECIMAL(4,2),
    "revision_reason" TEXT NOT NULL,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_salary_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pay_periods" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "month" DATE NOT NULL,
    "status" "PayStatus" NOT NULL DEFAULT 'OPEN',
    "locked_at" TIMESTAMPTZ,
    "locked_by_id" UUID,
    "lock_warnings" JSONB,
    "unlock_count" INTEGER NOT NULL DEFAULT 0,
    "last_unlock_reason" TEXT,
    "totals" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "pay_periods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_pay_summaries" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "pay_period_id" UUID NOT NULL,
    "period_start" DATE NOT NULL,
    "period_end" DATE NOT NULL,
    "salary_basis" "SalaryBasis",
    "rate" DECIMAL(14,2),
    "divisor_mode" TEXT NOT NULL,
    "divisor" DECIMAL(6,2) NOT NULL,
    "period_days" INTEGER NOT NULL,
    "employed_days" DECIMAL(6,2) NOT NULL,
    "entitled_days" DECIMAL(6,2) NOT NULL,
    "present_days" DECIMAL(6,2) NOT NULL,
    "half_days" DECIMAL(6,2) NOT NULL,
    "paid_holiday_days" DECIMAL(6,2) NOT NULL,
    "weekly_off_days" DECIMAL(6,2) NOT NULL,
    "paid_leave_days" DECIMAL(6,2) NOT NULL,
    "unpaid_leave_days" DECIMAL(6,2) NOT NULL,
    "absent_days" DECIMAL(6,2) NOT NULL,
    "lop_days" DECIMAL(6,2) NOT NULL,
    "payable_days" DECIMAL(6,2) NOT NULL,
    "worked_minutes" INTEGER NOT NULL,
    "ot_approved_minutes" INTEGER NOT NULL,
    "segments" JSONB NOT NULL DEFAULT '[]',
    "base_earned" DECIMAL(14,2) NOT NULL,
    "ot_earned" DECIMAL(14,2) NOT NULL,
    "additions" DECIMAL(14,2) NOT NULL,
    "deductions" DECIMAL(14,2) NOT NULL,
    "net_earned" DECIMAL(14,2) NOT NULL,
    "mtd_through" DATE,
    "projected_net" DECIMAL(14,2),
    "flags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "PayStatus" NOT NULL DEFAULT 'OPEN',
    "snapshot" JSONB,
    "inputs_hash" TEXT NOT NULL,
    "engine_version" TEXT NOT NULL,
    "computed_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "employee_pay_summaries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pay_adjustments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "pay_period_id" UUID NOT NULL,
    "direction" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "created_by_id" UUID NOT NULL,
    "voided_at" TIMESTAMPTZ,
    "voided_by_id" UUID,
    "void_reason" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pay_adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" "PlatformRole" NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "mfa_secret_enc" TEXT,
    "mfa_enabled" BOOLEAN NOT NULL DEFAULT false,
    "failed_logins" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ,
    "last_login_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "platform_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plans" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "price_per_employee" DECIMAL(10,2) NOT NULL,
    "min_billable_employees" INTEGER NOT NULL DEFAULT 0,
    "default_employee_cap" INTEGER,
    "trial_days" INTEGER NOT NULL DEFAULT 14,
    "payment_terms_days" INTEGER NOT NULL DEFAULT 15,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenants" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "legal_name" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "gstin" TEXT,
    "state_code" CHAR(2) NOT NULL,
    "billing_email" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    "status" "TenantStatus" NOT NULL DEFAULT 'TRIAL',
    "status_reason" TEXT,
    "payroll_tier" "PayrollTier" NOT NULL DEFAULT 'BASIC',
    "employee_cap" INTEGER,
    "support_access_allowed" BOOLEAN NOT NULL DEFAULT true,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_settings" (
    "tenant_id" UUID NOT NULL,
    "payable_days_basis" TEXT NOT NULL DEFAULT 'CALENDAR',
    "net_pay_rounding" TEXT NOT NULL DEFAULT 'NEAREST_RUPEE',
    "default_ot_multiplier" DECIMAL(4,2) NOT NULL DEFAULT 1.5,
    "activation_code_ttl_days" INTEGER NOT NULL DEFAULT 7,
    "default_site_radius_m" INTEGER NOT NULL DEFAULT 100,
    "default_max_accuracy_m" INTEGER NOT NULL DEFAULT 100,
    "accuracy_buffer_cap_m" INTEGER NOT NULL DEFAULT 25,
    "selfie_retention_days" INTEGER NOT NULL DEFAULT 90,
    "exited_purge_days" INTEGER NOT NULL DEFAULT 180,
    "missing_out_reminder" BOOLEAN NOT NULL DEFAULT true,
    "default_policy_id" UUID,
    "default_calendar_id" UUID,
    "default_pattern_id" UUID,
    "features_version" INTEGER NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "tenant_settings_pkey" PRIMARY KEY ("tenant_id")
);

-- CreateTable
CREATE TABLE "tenant_features" (
    "tenant_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',
    "updated_by_actor" "ActorType",
    "updated_by_id" UUID,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "tenant_features_pkey" PRIMARY KEY ("tenant_id","key")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'TRIALING',
    "billing_interval" TEXT NOT NULL DEFAULT 'MONTH',
    "current_period_start" DATE NOT NULL,
    "current_period_end" DATE NOT NULL,
    "next_due_date" DATE,
    "trial_ends_at" DATE,
    "price_override" DECIMAL(10,2),
    "discount_pct" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "provider" TEXT NOT NULL DEFAULT 'MANUAL',
    "suspended_at" TIMESTAMPTZ,
    "suspend_reason" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscription_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "subscription_id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "from_status" TEXT,
    "to_status" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "actor_type" "ActorType" NOT NULL,
    "actor_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscription_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscription_charges" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "subscription_id" UUID NOT NULL,
    "period_start" DATE NOT NULL,
    "period_end" DATE NOT NULL,
    "billable_employees" INTEGER NOT NULL,
    "unit_price" DECIMAL(10,2) NOT NULL,
    "subtotal" DECIMAL(14,2) NOT NULL,
    "gst_rate" DECIMAL(5,2) NOT NULL DEFAULT 18,
    "gst_amount" DECIMAL(14,2) NOT NULL,
    "total" DECIMAL(14,2) NOT NULL,
    "amount_paid" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "status" "ChargeStatus" NOT NULL DEFAULT 'DRAFT',
    "issued_at" TIMESTAMPTZ,
    "due_date" DATE,
    "paid_at" TIMESTAMPTZ,
    "invoice_no" TEXT,
    "notes" TEXT,
    "created_by_actor" "ActorType" NOT NULL,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "subscription_charges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "charge_id" UUID,
    "amount" DECIMAL(14,2) NOT NULL,
    "method" TEXT NOT NULL,
    "reference_no" TEXT,
    "received_on" DATE NOT NULL,
    "recorded_by_id" UUID NOT NULL,
    "notes" TEXT,
    "status" TEXT NOT NULL DEFAULT 'RECORDED',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_daily_snapshots" (
    "tenant_id" UUID NOT NULL,
    "snapshot_date" DATE NOT NULL,
    "active_employees" INTEGER NOT NULL,
    "invited_employees" INTEGER NOT NULL,
    "punches" INTEGER NOT NULL,
    "web_users" INTEGER NOT NULL,

    CONSTRAINT "usage_daily_snapshots_pkey" PRIMARY KEY ("tenant_id","snapshot_date")
);

-- CreateTable
CREATE TABLE "stored_files" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "bucket" TEXT NOT NULL,
    "object_key" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "created_by_actor" "ActorType" NOT NULL,
    "created_by_id" UUID,
    "expires_at" TIMESTAMPTZ,
    "deleted_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stored_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "export_jobs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "requested_by_id" UUID NOT NULL,
    "export_type" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "params" JSONB NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "file_id" UUID,
    "error" TEXT,
    "started_at" TIMESTAMPTZ,
    "finished_at" TIMESTAMPTZ,
    "expires_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "export_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "recipient_type" TEXT NOT NULL,
    "recipient_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "push_status" TEXT NOT NULL DEFAULT 'NONE',
    "sent_at" TIMESTAMPTZ,
    "read_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
    "occurred_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_type" "ActorType" NOT NULL,
    "actor_id" UUID,
    "actor_name" TEXT,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID,
    "before" JSONB,
    "after" JSONB,
    "reason" TEXT,
    "request_id" TEXT,
    "ip" TEXT,
    "user_agent" TEXT,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consent_notices" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
    "audience" TEXT NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'en',
    "version" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "body_md" TEXT NOT NULL,
    "purposes" JSONB NOT NULL,
    "published_at" TIMESTAMPTZ,
    "retired_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "consent_notices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consent_records" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "subject_type" TEXT NOT NULL,
    "subject_id" UUID NOT NULL,
    "notice_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "purposes" JSONB NOT NULL,
    "method" TEXT NOT NULL,
    "binding_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "consent_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_policies" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "hours_mode" "HoursMode" NOT NULL DEFAULT 'FIRST_IN_LAST_OUT',
    "late_grace_min" INTEGER NOT NULL DEFAULT 10,
    "early_leave_grace_min" INTEGER NOT NULL DEFAULT 10,
    "full_day_min_minutes" INTEGER,
    "half_day_min_minutes" INTEGER NOT NULL DEFAULT 240,
    "missing_out_treatment" "MissingOutTreatment" NOT NULL DEFAULT 'ABSENT',
    "min_punch_gap_sec" INTEGER NOT NULL DEFAULT 60,
    "block_mock_location" BOOLEAN NOT NULL DEFAULT true,
    "ot_min_minutes" INTEGER NOT NULL DEFAULT 30,
    "ot_rounding_minutes" INTEGER NOT NULL DEFAULT 15,
    "ot_daily_cap_minutes" INTEGER NOT NULL DEFAULT 240,
    "ot_requires_approval" BOOLEAN NOT NULL DEFAULT true,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "attendance_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shifts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "start_time" TEXT NOT NULL,
    "end_time" TEXT NOT NULL,
    "duty_minutes" INTEGER NOT NULL,
    "unpaid_break_minutes" INTEGER NOT NULL DEFAULT 0,
    "is_flexible" BOOLEAN NOT NULL DEFAULT false,
    "window_before_start_min" INTEGER NOT NULL DEFAULT 120,
    "window_after_end_min" INTEGER NOT NULL DEFAULT 360,
    "policy_id" UUID,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "shifts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shift_assignments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "shift_id" UUID NOT NULL,
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shift_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "weekly_off_patterns" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "rules" JSONB NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "weekly_off_patterns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "holiday_calendars" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "holiday_calendars_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "holidays" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "calendar_id" UUID NOT NULL,
    "holiday_date" DATE NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'COMPANY',
    "is_paid" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "holidays_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_day_overrides" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "override_date" DATE NOT NULL,
    "allow_punch" BOOLEAN NOT NULL DEFAULT true,
    "reason" TEXT NOT NULL,
    "created_by_id" UUID NOT NULL,
    "revoked_at" TIMESTAMPTZ,
    "revoked_by_id" UUID,
    "live_key" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_day_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leave_types" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "is_paid" BOOLEAN NOT NULL,
    "allow_half_day" BOOLEAN NOT NULL DEFAULT true,
    "accrual_mode" "AccrualMode" NOT NULL DEFAULT 'NONE',
    "annual_quota" DECIMAL(6,2),
    "monthly_accrual" DECIMAL(6,2),
    "carry_forward_cap" DECIMAL(6,2),
    "max_negative_balance" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "backdate_limit_days" INTEGER NOT NULL DEFAULT 7,
    "count_non_working_days" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "leave_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leave_requests" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "leave_type_id" UUID NOT NULL,
    "from_date" DATE NOT NULL,
    "from_part" "DayPart" NOT NULL DEFAULT 'FULL',
    "to_date" DATE NOT NULL,
    "to_part" "DayPart" NOT NULL DEFAULT 'FULL',
    "days" DECIMAL(6,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "LeaveRequestStatus" NOT NULL DEFAULT 'PENDING',
    "applied_by_actor" "ActorType" NOT NULL,
    "applied_by_id" UUID,
    "decided_by_id" UUID,
    "decided_at" TIMESTAMPTZ,
    "decision_note" TEXT,
    "cancelled_by_actor" "ActorType",
    "cancelled_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "leave_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leave_ledger" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "leave_type_id" UUID NOT NULL,
    "leave_year" INTEGER NOT NULL,
    "entry_type" "LeaveEntryType" NOT NULL,
    "days" DECIMAL(6,2) NOT NULL,
    "period_key" TEXT,
    "leave_request_id" UUID,
    "reason" TEXT,
    "actor_type" "ActorType" NOT NULL,
    "actor_id" UUID,
    "idempotency_key" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "leave_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leave_balances" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "leave_type_id" UUID NOT NULL,
    "leave_year" INTEGER NOT NULL,
    "opening" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "accrued" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "carried_in" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "used" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "credited" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "adjusted" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "lapsed" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "balance" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "pending" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "leave_balances_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "punches_tenant_id_employee_id_attendance_date_idx" ON "punches"("tenant_id", "employee_id", "attendance_date");

-- CreateIndex
CREATE INDEX "punches_tenant_id_server_time_idx" ON "punches"("tenant_id", "server_time" DESC);

-- CreateIndex
CREATE INDEX "punches_tenant_id_attendance_date_site_id_idx" ON "punches"("tenant_id", "attendance_date", "site_id");

-- CreateIndex
CREATE INDEX "punch_rejections_tenant_id_attempted_at_idx" ON "punch_rejections"("tenant_id", "attempted_at" DESC);

-- CreateIndex
CREATE INDEX "punch_rejections_tenant_id_employee_id_attempted_at_idx" ON "punch_rejections"("tenant_id", "employee_id", "attempted_at" DESC);

-- CreateIndex
CREATE INDEX "attendance_days_tenant_id_attendance_date_final_status_idx" ON "attendance_days"("tenant_id", "attendance_date", "final_status");

-- CreateIndex
CREATE INDEX "attendance_days_tenant_id_attendance_date_branch_id_idx" ON "attendance_days"("tenant_id", "attendance_date", "branch_id");

-- CreateIndex
CREATE INDEX "attendance_days_is_finalized_window_end_at_idx" ON "attendance_days"("is_finalized", "window_end_at");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_days_employee_id_attendance_date_key" ON "attendance_days"("employee_id", "attendance_date");

-- CreateIndex
CREATE INDEX "attendance_manual_marks_tenant_id_employee_id_attendance_da_idx" ON "attendance_manual_marks"("tenant_id", "employee_id", "attendance_date", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "roles_tenant_id_name_key" ON "roles"("tenant_id", "name");

-- CreateIndex
CREATE INDEX "tenant_memberships_tenant_id_role_id_idx" ON "tenant_memberships"("tenant_id", "role_id");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_memberships_tenant_id_user_id_key" ON "tenant_memberships"("tenant_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_invitations_token_hash_key" ON "user_invitations"("token_hash");

-- CreateIndex
CREATE INDEX "user_invitations_tenant_id_email_idx" ON "user_invitations"("tenant_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "password_reset_tokens_token_hash_key" ON "password_reset_tokens"("token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_tokens_family_id_idx" ON "refresh_tokens"("family_id");

-- CreateIndex
CREATE INDEX "refresh_tokens_realm_subject_id_idx" ON "refresh_tokens"("realm", "subject_id");

-- CreateIndex
CREATE INDEX "refresh_tokens_binding_id_idx" ON "refresh_tokens"("binding_id");

-- CreateIndex
CREATE UNIQUE INDEX "activation_codes_live_key_key" ON "activation_codes"("live_key");

-- CreateIndex
CREATE INDEX "activation_codes_tenant_id_status_expires_at_idx" ON "activation_codes"("tenant_id", "status", "expires_at");

-- CreateIndex
CREATE INDEX "activation_codes_tenant_id_employee_id_idx" ON "activation_codes"("tenant_id", "employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "device_bindings_live_employee_id_key" ON "device_bindings"("live_employee_id");

-- CreateIndex
CREATE INDEX "device_bindings_tenant_id_status_created_at_idx" ON "device_bindings"("tenant_id", "status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "device_bindings_tenant_id_employee_id_created_at_idx" ON "device_bindings"("tenant_id", "employee_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "device_bindings_key_fingerprint_idx" ON "device_bindings"("key_fingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "branches_tenant_id_name_key" ON "branches"("tenant_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "departments_tenant_id_name_key" ON "departments"("tenant_id", "name");

-- CreateIndex
CREATE INDEX "sites_tenant_id_branch_id_idx" ON "sites"("tenant_id", "branch_id");

-- CreateIndex
CREATE UNIQUE INDEX "sites_tenant_id_name_key" ON "sites"("tenant_id", "name");

-- CreateIndex
CREATE INDEX "employee_sites_tenant_id_site_id_idx" ON "employee_sites"("tenant_id", "site_id");

-- CreateIndex
CREATE UNIQUE INDEX "employees_live_phone_key" ON "employees"("live_phone");

-- CreateIndex
CREATE UNIQUE INDEX "employees_live_code_key_key" ON "employees"("live_code_key");

-- CreateIndex
CREATE INDEX "employees_tenant_id_status_idx" ON "employees"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "employees_tenant_id_branch_id_idx" ON "employees"("tenant_id", "branch_id");

-- CreateIndex
CREATE INDEX "employees_tenant_id_department_id_idx" ON "employees"("tenant_id", "department_id");

-- CreateIndex
CREATE INDEX "employees_tenant_id_full_name_idx" ON "employees"("tenant_id", "full_name");

-- CreateIndex
CREATE INDEX "employees_tenant_id_phone_e164_idx" ON "employees"("tenant_id", "phone_e164");

-- CreateIndex
CREATE INDEX "employee_imports_tenant_id_created_at_idx" ON "employee_imports"("tenant_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "employee_import_rows_tenant_id_import_id_status_idx" ON "employee_import_rows"("tenant_id", "import_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "employee_import_rows_import_id_row_no_key" ON "employee_import_rows"("import_id", "row_no");

-- CreateIndex
CREATE INDEX "employee_salary_assignments_tenant_id_employee_id_effective_idx" ON "employee_salary_assignments"("tenant_id", "employee_id", "effective_from" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "pay_periods_tenant_id_month_key" ON "pay_periods"("tenant_id", "month");

-- CreateIndex
CREATE INDEX "employee_pay_summaries_tenant_id_pay_period_id_status_idx" ON "employee_pay_summaries"("tenant_id", "pay_period_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "employee_pay_summaries_employee_id_period_start_key" ON "employee_pay_summaries"("employee_id", "period_start");

-- CreateIndex
CREATE INDEX "pay_adjustments_tenant_id_pay_period_id_employee_id_idx" ON "pay_adjustments"("tenant_id", "pay_period_id", "employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "platform_users_email_key" ON "platform_users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "plans_code_version_key" ON "plans"("code", "version");

-- CreateIndex
CREATE UNIQUE INDEX "tenants_slug_key" ON "tenants"("slug");

-- CreateIndex
CREATE INDEX "tenants_status_idx" ON "tenants"("status");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_tenant_id_key" ON "subscriptions"("tenant_id");

-- CreateIndex
CREATE INDEX "subscription_events_tenant_id_created_at_idx" ON "subscription_events"("tenant_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "subscription_charges_status_due_date_idx" ON "subscription_charges"("status", "due_date");

-- CreateIndex
CREATE INDEX "subscription_charges_tenant_id_period_start_idx" ON "subscription_charges"("tenant_id", "period_start" DESC);

-- CreateIndex
CREATE INDEX "payments_tenant_id_received_on_idx" ON "payments"("tenant_id", "received_on" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "stored_files_object_key_key" ON "stored_files"("object_key");

-- CreateIndex
CREATE INDEX "stored_files_tenant_id_purpose_created_at_idx" ON "stored_files"("tenant_id", "purpose", "created_at" DESC);

-- CreateIndex
CREATE INDEX "stored_files_expires_at_idx" ON "stored_files"("expires_at");

-- CreateIndex
CREATE INDEX "export_jobs_tenant_id_requested_by_id_created_at_idx" ON "export_jobs"("tenant_id", "requested_by_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "notifications_tenant_id_recipient_type_recipient_id_created_idx" ON "notifications"("tenant_id", "recipient_type", "recipient_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_tenant_id_occurred_at_idx" ON "audit_logs"("tenant_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_tenant_id_entity_type_entity_id_occurred_at_idx" ON "audit_logs"("tenant_id", "entity_type", "entity_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_actor_id_occurred_at_idx" ON "audit_logs"("actor_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "consent_notices_audience_language_published_at_idx" ON "consent_notices"("audience", "language", "published_at");

-- CreateIndex
CREATE INDEX "consent_records_tenant_id_subject_type_subject_id_created_a_idx" ON "consent_records"("tenant_id", "subject_type", "subject_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "attendance_policies_tenant_id_name_key" ON "attendance_policies"("tenant_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "shifts_tenant_id_name_key" ON "shifts"("tenant_id", "name");

-- CreateIndex
CREATE INDEX "shift_assignments_tenant_id_employee_id_effective_from_idx" ON "shift_assignments"("tenant_id", "employee_id", "effective_from" DESC);

-- CreateIndex
CREATE INDEX "shift_assignments_tenant_id_shift_id_idx" ON "shift_assignments"("tenant_id", "shift_id");

-- CreateIndex
CREATE UNIQUE INDEX "weekly_off_patterns_tenant_id_name_key" ON "weekly_off_patterns"("tenant_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "holiday_calendars_tenant_id_name_key" ON "holiday_calendars"("tenant_id", "name");

-- CreateIndex
CREATE INDEX "holidays_tenant_id_holiday_date_idx" ON "holidays"("tenant_id", "holiday_date");

-- CreateIndex
CREATE UNIQUE INDEX "holidays_calendar_id_holiday_date_key" ON "holidays"("calendar_id", "holiday_date");

-- CreateIndex
CREATE UNIQUE INDEX "employee_day_overrides_live_key_key" ON "employee_day_overrides"("live_key");

-- CreateIndex
CREATE INDEX "employee_day_overrides_tenant_id_override_date_idx" ON "employee_day_overrides"("tenant_id", "override_date");

-- CreateIndex
CREATE INDEX "employee_day_overrides_tenant_id_employee_id_override_date_idx" ON "employee_day_overrides"("tenant_id", "employee_id", "override_date");

-- CreateIndex
CREATE UNIQUE INDEX "leave_types_tenant_id_code_key" ON "leave_types"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "leave_requests_tenant_id_employee_id_from_date_idx" ON "leave_requests"("tenant_id", "employee_id", "from_date");

-- CreateIndex
CREATE INDEX "leave_requests_tenant_id_status_from_date_idx" ON "leave_requests"("tenant_id", "status", "from_date");

-- CreateIndex
CREATE UNIQUE INDEX "leave_ledger_idempotency_key_key" ON "leave_ledger"("idempotency_key");

-- CreateIndex
CREATE INDEX "leave_ledger_tenant_id_employee_id_leave_type_id_leave_year_idx" ON "leave_ledger"("tenant_id", "employee_id", "leave_type_id", "leave_year");

-- CreateIndex
CREATE INDEX "leave_balances_tenant_id_leave_year_idx" ON "leave_balances"("tenant_id", "leave_year");

-- CreateIndex
CREATE UNIQUE INDEX "leave_balances_employee_id_leave_type_id_leave_year_key" ON "leave_balances"("employee_id", "leave_type_id", "leave_year");

-- AddForeignKey
ALTER TABLE "punches" ADD CONSTRAINT "punches_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_days" ADD CONSTRAINT "attendance_days_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_memberships" ADD CONSTRAINT "tenant_memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_memberships" ADD CONSTRAINT "tenant_memberships_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activation_codes" ADD CONSTRAINT "activation_codes_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_bindings" ADD CONSTRAINT "device_bindings_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sites" ADD CONSTRAINT "sites_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_sites" ADD CONSTRAINT "employee_sites_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_sites" ADD CONSTRAINT "employee_sites_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_import_rows" ADD CONSTRAINT "employee_import_rows_import_id_fkey" FOREIGN KEY ("import_id") REFERENCES "employee_imports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_salary_assignments" ADD CONSTRAINT "employee_salary_assignments_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_pay_summaries" ADD CONSTRAINT "employee_pay_summaries_pay_period_id_fkey" FOREIGN KEY ("pay_period_id") REFERENCES "pay_periods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pay_adjustments" ADD CONSTRAINT "pay_adjustments_pay_period_id_fkey" FOREIGN KEY ("pay_period_id") REFERENCES "pay_periods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_settings" ADD CONSTRAINT "tenant_settings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_features" ADD CONSTRAINT "tenant_features_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_events" ADD CONSTRAINT "subscription_events_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "subscriptions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_charges" ADD CONSTRAINT "subscription_charges_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "subscriptions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_charge_id_fkey" FOREIGN KEY ("charge_id") REFERENCES "subscription_charges"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_assignments" ADD CONSTRAINT "shift_assignments_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_assignments" ADD CONSTRAINT "shift_assignments_shift_id_fkey" FOREIGN KEY ("shift_id") REFERENCES "shifts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "holidays" ADD CONSTRAINT "holidays_calendar_id_fkey" FOREIGN KEY ("calendar_id") REFERENCES "holiday_calendars"("id") ON DELETE CASCADE ON UPDATE CASCADE;
