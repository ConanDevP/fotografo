-- Migration: add_free_downloads
-- Add free download functionality with analytics

-- 1. Add free download fields to events table
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "is_free_download" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "free_download_until" TIMESTAMPTZ;
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "require_email_for_free" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "free_download_limit" INTEGER;
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "total_free_downloads" INTEGER NOT NULL DEFAULT 0;

-- 2. Create free_downloads table for analytics
CREATE TABLE IF NOT EXISTS "free_downloads" (
    "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "event_id" UUID NOT NULL,
    "photo_id" UUID NOT NULL,
    "email" TEXT,
    "name" TEXT,
    "phone" TEXT,
    "bib_number" TEXT,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "referer" TEXT,
    "country" TEXT,
    "city" TEXT,
    "downloaded_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT "free_downloads_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE,
    CONSTRAINT "free_downloads_photo_id_fkey" FOREIGN KEY ("photo_id") REFERENCES "photos"("id") ON DELETE CASCADE
);

-- 3. Create indexes for performance
CREATE INDEX IF NOT EXISTS "free_downloads_event_id_idx" ON "free_downloads"("event_id");
CREATE INDEX IF NOT EXISTS "free_downloads_photo_id_idx" ON "free_downloads"("photo_id");
CREATE INDEX IF NOT EXISTS "free_downloads_email_idx" ON "free_downloads"("email");
CREATE INDEX IF NOT EXISTS "free_downloads_downloaded_at_idx" ON "free_downloads"("downloaded_at");
