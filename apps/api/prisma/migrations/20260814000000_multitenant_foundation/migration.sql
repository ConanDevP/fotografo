-- LucilaMon multi-tenant foundation.
-- This migration is intentionally additive so existing events, photos and orders remain usable.

CREATE TYPE "WorkspaceType" AS ENUM ('PHOTOGRAPHER', 'ORGANIZER', 'STUDIO');
CREATE TYPE "WorkspaceRole" AS ENUM ('OWNER', 'ADMIN', 'EDITOR', 'PHOTOGRAPHER', 'ANALYST', 'SUPPORT');
CREATE TYPE "MembershipStatus" AS ENUM ('ACTIVE', 'SUSPENDED');
CREATE TYPE "EventCommerceMode" AS ENUM ('FREE', 'SPONSORED_FREE', 'PAID', 'HYBRID', 'PRIVATE');
CREATE TYPE "PhotoPublicationStatus" AS ENUM ('PENDING_REVIEW', 'APPROVED', 'REJECTED');
CREATE TYPE "EventContributorRole" AS ENUM ('PHOTOGRAPHER', 'EDITOR', 'EVENT_MANAGER');
CREATE TYPE "ContributorStatus" AS ENUM ('INVITED', 'ACCEPTED', 'DECLINED', 'REVOKED');
CREATE TYPE "SponsorStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'ENDED');
CREATE TYPE "DownloadVariant" AS ENUM ('PREVIEW', 'SPONSORED', 'CLEAN', 'SOCIAL');
CREATE TYPE "MetricType" AS ENUM (
  'WORKSPACE_VIEW', 'EVENT_VIEW', 'PHOTO_VIEW', 'BIB_SEARCH', 'FACE_SEARCH',
  'SEARCH_NO_RESULTS', 'ADD_TO_CART', 'CHECKOUT_STARTED', 'PURCHASE_COMPLETED',
  'FREE_DOWNLOAD', 'PAID_DOWNLOAD', 'SPONSOR_CLICK', 'SPONSOR_DOWNLOAD_EXPOSURE'
);
CREATE TYPE "LedgerEntryType" AS ENUM (
  'GROSS_SALE', 'PROCESSOR_FEE', 'PLATFORM_FEE', 'ORGANIZER_COMMISSION',
  'PHOTOGRAPHER_EARNING', 'REFUND'
);
CREATE TYPE "LedgerEntryStatus" AS ENUM ('PENDING', 'AVAILABLE', 'PAID_OUT', 'REVERSED');

CREATE TABLE "workspaces" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "type" "WorkspaceType" NOT NULL,
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "description" TEXT,
  "logo_url" TEXT,
  "cover_url" TEXT,
  "contact_email" TEXT,
  "website" TEXT,
  "instagram" TEXT,
  "facebook" TEXT,
  "custom_domain" TEXT,
  "custom_domain_verification_token" TEXT,
  "custom_domain_verified_at" TIMESTAMPTZ(6),
  "is_published" BOOLEAN NOT NULL DEFAULT false,
  "owner_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deleted_at" TIMESTAMPTZ(6),
  CONSTRAINT "workspaces_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "workspaces_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "workspaces_slug_key" ON "workspaces"("slug");
CREATE UNIQUE INDEX "workspaces_custom_domain_key" ON "workspaces"("custom_domain");
CREATE INDEX "workspaces_owner_id_idx" ON "workspaces"("owner_id");
CREATE INDEX "workspaces_type_is_published_idx" ON "workspaces"("type", "is_published");

CREATE TABLE "brand_themes" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL,
  "template" TEXT NOT NULL DEFAULT 'editorial',
  "primary_color" TEXT NOT NULL DEFAULT '#111111',
  "secondary_color" TEXT NOT NULL DEFAULT '#F5F1E8',
  "accent_color" TEXT NOT NULL DEFAULT '#C6FF00',
  "font_family" TEXT NOT NULL DEFAULT 'Inter',
  "hero_title" TEXT,
  "hero_subtitle" TEXT,
  "show_past_events" BOOLEAN NOT NULL DEFAULT true,
  "settings" JSONB,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "brand_themes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "brand_themes_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "brand_themes_workspace_id_key" ON "brand_themes"("workspace_id");

CREATE TABLE "workspace_members" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "role" "WorkspaceRole" NOT NULL,
  "status" "MembershipStatus" NOT NULL DEFAULT 'ACTIVE',
  "joined_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "workspace_members_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "workspace_members_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "workspace_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "workspace_members_workspace_id_user_id_key" ON "workspace_members"("workspace_id", "user_id");
CREATE INDEX "workspace_members_user_id_status_idx" ON "workspace_members"("user_id", "status");

ALTER TABLE "events"
  ADD COLUMN "workspace_id" UUID,
  ADD COLUMN "commerce_mode" "EventCommerceMode" NOT NULL DEFAULT 'PAID',
  ADD COLUMN "organizer_commission_percent" DECIMAL(5,2) NOT NULL DEFAULT 0,
  ADD COLUMN "sponsor_overlay_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "requires_photo_approval" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "is_published" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "published_at" TIMESTAMPTZ(6);

ALTER TABLE "events"
  ADD CONSTRAINT "events_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "events_workspace_id_is_published_idx" ON "events"("workspace_id", "is_published");

ALTER TABLE "photos"
  ADD COLUMN "photographer_workspace_id" UUID,
  ADD COLUMN "content_hash" TEXT,
  ADD COLUMN "publication_status" "PhotoPublicationStatus" NOT NULL DEFAULT 'APPROVED',
  ADD COLUMN "review_note" TEXT,
  ADD COLUMN "reviewed_at" TIMESTAMPTZ(6),
  ADD COLUMN "reviewed_by_id" UUID;
ALTER TABLE "photos"
  ADD CONSTRAINT "photos_photographer_workspace_id_fkey" FOREIGN KEY ("photographer_workspace_id") REFERENCES "workspaces"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "photos_photographer_workspace_id_idx" ON "photos"("photographer_workspace_id");
CREATE UNIQUE INDEX "photos_event_id_photographer_id_content_hash_key" ON "photos"("event_id", "photographer_id", "content_hash");

-- Existing photographer profiles become published workspaces and retain event ownership.
INSERT INTO "workspaces" ("type", "name", "slug", "description", "logo_url", "contact_email", "website", "instagram", "facebook", "is_published", "owner_id")
SELECT
  CASE
    WHEN u."role" = 'ORGANIZER' THEN 'ORGANIZER'::"WorkspaceType"
    ELSE 'PHOTOGRAPHER'::"WorkspaceType"
  END,
  COALESCE(NULLIF(u."name", ''), split_part(u."email", '@', 1)),
  COALESCE(NULLIF(u."slug", ''), 'fotografo-' || replace(u."id"::text, '-', '')),
  u."bio",
  u."profile_image_url",
  u."email",
  u."website",
  u."instagram",
  u."facebook",
  true,
  u."id"
FROM "users" u
WHERE u."role" IN ('PHOTOGRAPHER', 'ORGANIZER')
ON CONFLICT ("slug") DO NOTHING;

INSERT INTO "brand_themes" ("workspace_id", "hero_title", "hero_subtitle")
SELECT w."id", w."name", w."description"
FROM "workspaces" w
ON CONFLICT ("workspace_id") DO NOTHING;

INSERT INTO "workspace_members" ("workspace_id", "user_id", "role", "status")
SELECT w."id", w."owner_id", 'OWNER'::"WorkspaceRole", 'ACTIVE'::"MembershipStatus"
FROM "workspaces" w
ON CONFLICT ("workspace_id", "user_id") DO NOTHING;

UPDATE "events" e
SET "workspace_id" = w."id"
FROM "workspaces" w
WHERE e."owner_id" = w."owner_id" AND e."workspace_id" IS NULL;

UPDATE "events"
SET "is_published" = true,
    "published_at" = COALESCE("created_at", CURRENT_TIMESTAMP),
    "commerce_mode" = CASE WHEN "is_free_download" THEN 'FREE'::"EventCommerceMode" ELSE 'PAID'::"EventCommerceMode" END
WHERE "deleted_at" IS NULL;

UPDATE "photos" p
SET "photographer_workspace_id" = w."id"
FROM "workspaces" w
WHERE p."photographer_id" = w."owner_id" AND p."photographer_workspace_id" IS NULL;

-- Make OCR retries idempotent before adding the uniqueness guarantee.
DELETE FROM "photo_bibs" duplicate
USING "photo_bibs" keeper
WHERE duplicate."id" > keeper."id"
  AND duplicate."photo_id" = keeper."photo_id"
  AND duplicate."bib" = keeper."bib"
  AND duplicate."source" = keeper."source";
CREATE UNIQUE INDEX "photo_bibs_photo_id_bib_source_key" ON "photo_bibs"("photo_id", "bib", "source");

ALTER TABLE "orders"
  ADD COLUMN "payment_gateway" TEXT,
  ADD COLUMN "payment_id" TEXT,
  ADD COLUMN "guest_email" TEXT,
  ADD COLUMN "access_token_hash" TEXT,
  ADD COLUMN "idempotency_key" TEXT,
  ADD COLUMN "paid_at" TIMESTAMPTZ(6),
  ADD COLUMN "refunded_at" TIMESTAMPTZ(6),
  ADD COLUMN "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP;
CREATE UNIQUE INDEX "orders_payment_id_key" ON "orders"("payment_id");
CREATE UNIQUE INDEX "orders_idempotency_key_key" ON "orders"("idempotency_key");

ALTER TABLE "order_items" ADD COLUMN "beneficiary_workspace_id" UUID;
ALTER TABLE "order_items"
  ADD CONSTRAINT "order_items_beneficiary_workspace_id_fkey" FOREIGN KEY ("beneficiary_workspace_id") REFERENCES "workspaces"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "order_items_beneficiary_workspace_id_idx" ON "order_items"("beneficiary_workspace_id");

CREATE TABLE "event_contributors" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "event_id" UUID NOT NULL,
  "user_id" UUID,
  "photographer_workspace_id" UUID,
  "invited_email" TEXT NOT NULL,
  "role" "EventContributorRole" NOT NULL DEFAULT 'PHOTOGRAPHER',
  "status" "ContributorStatus" NOT NULL DEFAULT 'INVITED',
  "organizer_commission_percent" DECIMAL(5,2) NOT NULL DEFAULT 0,
  "rights_terms" TEXT,
  "rights_accepted_at" TIMESTAMPTZ(6),
  "token_hash" TEXT NOT NULL,
  "invited_by_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "event_contributors_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "event_contributors_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "event_contributors_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "event_contributors_photographer_workspace_id_fkey" FOREIGN KEY ("photographer_workspace_id") REFERENCES "workspaces"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "event_contributors_invited_by_id_fkey" FOREIGN KEY ("invited_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "event_contributors_token_hash_key" ON "event_contributors"("token_hash");
CREATE UNIQUE INDEX "event_contributors_event_id_user_id_key" ON "event_contributors"("event_id", "user_id");
CREATE UNIQUE INDEX "event_contributors_event_id_photographer_workspace_id_key" ON "event_contributors"("event_id", "photographer_workspace_id");
CREATE INDEX "event_contributors_invited_email_status_idx" ON "event_contributors"("invited_email", "status");

CREATE TABLE "sponsors" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "logo_url" TEXT NOT NULL,
  "website_url" TEXT,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "sponsors_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "sponsors_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "sponsors_workspace_id_is_active_idx" ON "sponsors"("workspace_id", "is_active");

CREATE TABLE "event_sponsors" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "event_id" UUID NOT NULL,
  "sponsor_id" UUID NOT NULL,
  "status" "SponsorStatus" NOT NULL DEFAULT 'ACTIVE',
  "priority" INTEGER NOT NULL DEFAULT 0,
  "required_on_free_downloads" BOOLEAN NOT NULL DEFAULT true,
  "placement" JSONB,
  "starts_at" TIMESTAMPTZ(6),
  "ends_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "event_sponsors_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "event_sponsors_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "event_sponsors_sponsor_id_fkey" FOREIGN KEY ("sponsor_id") REFERENCES "sponsors"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "event_sponsors_event_id_sponsor_id_key" ON "event_sponsors"("event_id", "sponsor_id");
CREATE INDEX "event_sponsors_event_id_status_priority_idx" ON "event_sponsors"("event_id", "status", "priority");

CREATE TABLE "download_assets" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "event_id" UUID NOT NULL,
  "photo_id" UUID NOT NULL,
  "variant" "DownloadVariant" NOT NULL,
  "storage_key" TEXT NOT NULL,
  "url" TEXT NOT NULL,
  "sponsor_signature" TEXT NOT NULL DEFAULT 'none',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "download_assets_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "download_assets_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "download_assets_photo_id_fkey" FOREIGN KEY ("photo_id") REFERENCES "photos"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "download_assets_photo_id_variant_sponsor_signature_key" ON "download_assets"("photo_id", "variant", "sponsor_signature");
CREATE INDEX "download_assets_event_id_variant_idx" ON "download_assets"("event_id", "variant");

CREATE TABLE "metric_events" (
  "id" BIGSERIAL NOT NULL,
  "workspace_id" UUID,
  "event_id" UUID,
  "photo_id" UUID,
  "order_id" UUID,
  "user_id" UUID,
  "session_id" TEXT,
  "visitor_hash" TEXT,
  "type" "MetricType" NOT NULL,
  "source" TEXT,
  "metadata" JSONB,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "metric_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "metric_events_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "metric_events_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "metric_events_photo_id_fkey" FOREIGN KEY ("photo_id") REFERENCES "photos"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "metric_events_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "metric_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "metric_events_workspace_id_created_at_idx" ON "metric_events"("workspace_id", "created_at");
CREATE INDEX "metric_events_event_id_type_created_at_idx" ON "metric_events"("event_id", "type", "created_at");

CREATE TABLE "ledger_entries" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "order_id" UUID NOT NULL,
  "event_id" UUID,
  "workspace_id" UUID,
  "beneficiary_user_id" UUID,
  "type" "LedgerEntryType" NOT NULL,
  "status" "LedgerEntryStatus" NOT NULL DEFAULT 'PENDING',
  "amount_cents" INTEGER NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "metadata" JSONB,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ledger_entries_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ledger_entries_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "ledger_entries_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "ledger_entries_beneficiary_user_id_fkey" FOREIGN KEY ("beneficiary_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "ledger_entries_order_id_type_idx" ON "ledger_entries"("order_id", "type");
CREATE INDEX "ledger_entries_workspace_id_status_idx" ON "ledger_entries"("workspace_id", "status");
