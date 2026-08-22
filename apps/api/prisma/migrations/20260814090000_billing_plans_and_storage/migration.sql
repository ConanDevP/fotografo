-- Facturación: planes, suscripciones y medición de almacenamiento.

CREATE TYPE "PlanAudience" AS ENUM ('PHOTOGRAPHER', 'ORGANIZER', 'ANY');
CREATE TYPE "SubscriptionStatus" AS ENUM ('ACTIVE', 'PAST_DUE', 'CANCELED');

CREATE TABLE "plans" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "audience" "PlanAudience" NOT NULL DEFAULT 'ANY',
    "description" TEXT,
    "price_cents" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "commission_percent" DECIMAL(5,2) NOT NULL,
    "included_storage_bytes" BIGINT NOT NULL,
    "extra_storage_block_bytes" BIGINT,
    "extra_storage_block_cents" INTEGER,
    "sponsored_event_fee_cents" INTEGER NOT NULL DEFAULT 0,
    "max_admins" INTEGER,
    "allows_custom_domain" BOOLEAN NOT NULL DEFAULT false,
    "allows_sponsors" BOOLEAN NOT NULL DEFAULT false,
    "allows_advanced_metrics" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "stripe_price_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "plans_slug_key" ON "plans"("slug");
CREATE UNIQUE INDEX "plans_stripe_price_id_key" ON "plans"("stripe_price_id");
CREATE INDEX "plans_audience_is_active_sort_order_idx" ON "plans"("audience", "is_active", "sort_order");

CREATE TABLE "subscriptions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
    "extra_storage_blocks" INTEGER NOT NULL DEFAULT 0,
    "current_period_end" TIMESTAMPTZ(6),
    "cancel_at_period_end" BOOLEAN NOT NULL DEFAULT false,
    "stripe_customer_id" TEXT,
    "stripe_subscription_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "subscriptions_workspace_id_key" ON "subscriptions"("workspace_id");
CREATE UNIQUE INDEX "subscriptions_stripe_subscription_id_key" ON "subscriptions"("stripe_subscription_id");
CREATE INDEX "subscriptions_plan_id_status_idx" ON "subscriptions"("plan_id", "status");

ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_plan_id_fkey"
    FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Medidor de consumo.
ALTER TABLE "workspaces" ADD COLUMN "storage_bytes_used" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "photos" ADD COLUMN "original_bytes" INTEGER;
ALTER TABLE "photos" ADD COLUMN "derived_bytes" INTEGER;
