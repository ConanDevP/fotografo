CREATE TYPE "EnterpriseAccountStatus" AS ENUM ('PROSPECT', 'PILOT', 'ACTIVE', 'SUSPENDED', 'ENDED');

CREATE TABLE "enterprise_accounts" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(), "workspace_id" UUID NOT NULL,
  "status" "EnterpriseAccountStatus" NOT NULL DEFAULT 'PROSPECT',
  "contract_start" TIMESTAMPTZ(6), "contract_end" TIMESTAMPTZ(6),
  "annual_price_cents" INTEGER, "currency" VARCHAR(3) NOT NULL DEFAULT 'USD',
  "contract_reference" TEXT, "legal_name" TEXT, "account_manager" TEXT,
  "business_contact_email" TEXT, "technical_contact_email" TEXT,
  "billing_contact_email" TEXT, "security_contact_email" TEXT, "internal_notes" TEXT,
  "partner_api_enabled" BOOLEAN NOT NULL DEFAULT false,
  "webhooks_enabled" BOOLEAN NOT NULL DEFAULT false, "face_search_enabled" BOOLEAN NOT NULL DEFAULT false,
  "sponsors_enabled" BOOLEAN NOT NULL DEFAULT false, "custom_domain_enabled" BOOLEAN NOT NULL DEFAULT false,
  "advanced_analytics_enabled" BOOLEAN NOT NULL DEFAULT false, "exports_enabled" BOOLEAN NOT NULL DEFAULT false,
  "original_downloads_enabled" BOOLEAN NOT NULL DEFAULT false,
  "sponsored_downloads_enabled" BOOLEAN NOT NULL DEFAULT false,
  "priority_processing_enabled" BOOLEAN NOT NULL DEFAULT false,
  "annual_photo_limit" INTEGER, "annual_event_limit" INTEGER, "monthly_api_request_limit" INTEGER,
  "monthly_face_search_limit" INTEGER, "max_api_clients" INTEGER, "max_webhook_endpoints" INTEGER,
  "max_admins" INTEGER, "retention_days" INTEGER, "created_by_id" UUID, "updated_by_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "enterprise_accounts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "enterprise_accounts_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "enterprise_accounts_workspace_id_key" ON "enterprise_accounts"("workspace_id");
CREATE INDEX "enterprise_accounts_status_contract_end_idx" ON "enterprise_accounts"("status", "contract_end");

CREATE TABLE "partner_api_usage" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(), "workspace_id" UUID NOT NULL, "period" VARCHAR(7) NOT NULL,
  "request_count" BIGINT NOT NULL DEFAULT 0, "face_search_count" BIGINT NOT NULL DEFAULT 0,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "partner_api_usage_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "partner_api_usage_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "partner_api_usage_workspace_id_period_key" ON "partner_api_usage"("workspace_id", "period");
