-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "branding" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "tenant_features" ADD COLUMN     "locked_by_platform" BOOLEAN NOT NULL DEFAULT false;
