-- CreateEnum
CREATE TYPE "RegState" AS ENUM ('NOT_APPLICABLE', 'AVAILABLE', 'REQUESTED', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "RegRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

-- AlterTable
ALTER TABLE "attendance_days" ADD COLUMN     "needs_recompute" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "outside_early_minutes" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "outside_late_minutes" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "outside_minutes" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "reg_approved_minutes" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "reg_state" "RegState" NOT NULL DEFAULT 'NOT_APPLICABLE';

-- AlterTable
ALTER TABLE "employee_pay_summaries" ADD COLUMN     "is_stale" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "tenant_settings" ADD COLUMN     "default_shift_id" UUID,
ADD COLUMN     "housekept_on" DATE;

-- AlterTable
ALTER TABLE "attendance_policies" ADD COLUMN     "max_punches_per_day" INTEGER NOT NULL DEFAULT 6,
ADD COLUMN     "outside_min_minutes" INTEGER NOT NULL DEFAULT 15;

-- CreateTable
CREATE TABLE "regularization_requests" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "attendance_date" DATE NOT NULL,
    "outside_minutes" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "RegRequestStatus" NOT NULL DEFAULT 'PENDING',
    "approved_minutes" INTEGER NOT NULL DEFAULT 0,
    "decided_by_id" UUID,
    "decided_at" TIMESTAMPTZ,
    "decision_note" TEXT,
    "live_key" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "regularization_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "regularization_requests_live_key_key" ON "regularization_requests"("live_key");

-- CreateIndex
CREATE INDEX "regularization_requests_tenant_id_status_attendance_date_idx" ON "regularization_requests"("tenant_id", "status", "attendance_date");

-- CreateIndex
CREATE INDEX "regularization_requests_tenant_id_employee_id_attendance_da_idx" ON "regularization_requests"("tenant_id", "employee_id", "attendance_date");

-- CreateIndex
CREATE INDEX "attendance_days_tenant_id_needs_recompute_attendance_date_idx" ON "attendance_days"("tenant_id", "needs_recompute", "attendance_date");

-- AddForeignKey
ALTER TABLE "regularization_requests" ADD CONSTRAINT "regularization_requests_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

