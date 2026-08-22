-- Align legacy column definitions with the Prisma schema so fresh installs and
-- upgraded installations produce the same database.

UPDATE "users"
SET
  "stripe_onboarding_completed" = COALESCE("stripe_onboarding_completed", false),
  "stripe_charges_enabled" = COALESCE("stripe_charges_enabled", false),
  "stripe_payouts_enabled" = COALESCE("stripe_payouts_enabled", false),
  "is_featured" = COALESCE("is_featured", false),
  "is_verified" = COALESCE("is_verified", false);

ALTER TABLE "users"
  ALTER COLUMN "stripe_onboarding_completed" SET NOT NULL,
  ALTER COLUMN "stripe_charges_enabled" SET NOT NULL,
  ALTER COLUMN "stripe_payouts_enabled" SET NOT NULL,
  ALTER COLUMN "is_featured" SET NOT NULL,
  ALTER COLUMN "is_verified" SET NOT NULL,
  ALTER COLUMN "slug" TYPE TEXT,
  ALTER COLUMN "website" TYPE TEXT,
  ALTER COLUMN "instagram" TYPE TEXT,
  ALTER COLUMN "facebook" TYPE TEXT,
  ALTER COLUMN "location" TYPE TEXT,
  ALTER COLUMN "portfolio_url" TYPE TEXT,
  ALTER COLUMN "updated_at" DROP DEFAULT;

ALTER TABLE "athlete_signatures" ALTER COLUMN "updated_at" DROP DEFAULT;
ALTER TABLE "batch_upload_jobs" ALTER COLUMN "updated_at" DROP DEFAULT;
ALTER TABLE "batch_upload_items" ALTER COLUMN "updated_at" DROP DEFAULT;
ALTER TABLE "brand_themes" ALTER COLUMN "updated_at" DROP DEFAULT;
ALTER TABLE "event_contributors" ALTER COLUMN "updated_at" DROP DEFAULT;
ALTER TABLE "orders" ALTER COLUMN "updated_at" DROP DEFAULT;
ALTER TABLE "sponsors" ALTER COLUMN "updated_at" DROP DEFAULT;
ALTER TABLE "workspaces" ALTER COLUMN "updated_at" DROP DEFAULT;

CREATE INDEX IF NOT EXISTS "users_slug_idx" ON "users"("slug");
CREATE INDEX IF NOT EXISTS "users_role_is_featured_idx" ON "users"("role", "is_featured");

ALTER TABLE "free_downloads" DROP CONSTRAINT IF EXISTS "free_downloads_event_id_fkey";
ALTER TABLE "free_downloads" DROP CONSTRAINT IF EXISTS "free_downloads_photo_id_fkey";
ALTER TABLE "free_downloads"
  ADD CONSTRAINT "free_downloads_event_id_fkey"
    FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "free_downloads_photo_id_fkey"
    FOREIGN KEY ("photo_id") REFERENCES "photos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

