-- Baseline for installations that start from an empty PostgreSQL database.
-- IF NOT EXISTS keeps this safe for legacy databases that were originally
-- provisioned with `prisma db push` before migrations were checked in.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$ BEGIN
  CREATE TYPE "UserRole" AS ENUM ('ATHLETE', 'PHOTOGRAPHER', 'ADMIN');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "PhotoStatus" AS ENUM ('PENDING', 'PROCESSED', 'FAILED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "OrderStatus" AS ENUM ('CREATED', 'PAID', 'CANCELLED', 'REFUNDED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "ItemType" AS ENUM ('PHOTO', 'PACKAGE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "BatchUploadStatus" AS ENUM ('PENDING', 'UPLOADING', 'PROCESSING', 'COMPLETED', 'FAILED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "users" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "email" TEXT NOT NULL,
  "password_hash" TEXT,
  "role" "UserRole" NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "users_email_key" ON "users"("email");

CREATE TABLE IF NOT EXISTS "events" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "date" DATE NOT NULL,
  "location" TEXT,
  "image_url" TEXT,
  "owner_id" UUID,
  "bib_rules" JSONB,
  "pricing" JSONB,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "events_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "events_slug_key" ON "events"("slug");

CREATE TABLE IF NOT EXISTS "batch_upload_jobs" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "status" "BatchUploadStatus" NOT NULL DEFAULT 'PENDING',
  "totalFiles" INTEGER NOT NULL,
  "uploadedFiles" INTEGER NOT NULL DEFAULT 0,
  "processedFiles" INTEGER NOT NULL DEFAULT 0,
  "owner_id" UUID NOT NULL,
  "event_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "batch_upload_jobs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "batch_upload_jobs_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "batch_upload_jobs_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "photos" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "event_id" UUID NOT NULL,
  "photographer_id" UUID,
  "cloudinary_id" TEXT NOT NULL,
  "original_url" TEXT NOT NULL,
  "thumb_url" TEXT,
  "watermark_url" TEXT,
  "width" INTEGER,
  "height" INTEGER,
  "taken_at" TIMESTAMPTZ(6),
  "status" "PhotoStatus" NOT NULL DEFAULT 'PENDING',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "batch_job_id" UUID,
  CONSTRAINT "photos_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "photos_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "photos_photographer_id_fkey" FOREIGN KEY ("photographer_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "photos_batch_job_id_fkey" FOREIGN KEY ("batch_job_id") REFERENCES "batch_upload_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "photos_event_id_idx" ON "photos"("event_id");

CREATE TABLE IF NOT EXISTS "photo_bibs" (
  "id" BIGSERIAL NOT NULL,
  "photo_id" UUID NOT NULL,
  "event_id" UUID NOT NULL,
  "bib" TEXT NOT NULL,
  "confidence" DECIMAL(4,3) NOT NULL,
  "bbox" JSONB,
  "source" TEXT NOT NULL DEFAULT 'GEMINI',
  "prompt_tokens" INTEGER,
  "candidates_tokens" INTEGER,
  "total_tokens" INTEGER,
  "gemini_image_width" INTEGER,
  "gemini_image_height" INTEGER,
  CONSTRAINT "photo_bibs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "photo_bibs_photo_id_fkey" FOREIGN KEY ("photo_id") REFERENCES "photos"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "photo_bibs_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "idx_bibs_event_bib" ON "photo_bibs"("event_id", "bib");

CREATE TABLE IF NOT EXISTS "bib_subscriptions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "event_id" UUID NOT NULL,
  "bib" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "bib_subscriptions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "bib_subscriptions_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "orders" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id" UUID,
  "event_id" UUID,
  "amount_cents" INTEGER NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "status" "OrderStatus" NOT NULL,
  "stripe_session_id" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "orders_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "orders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "orders_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "order_items" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "order_id" UUID NOT NULL,
  "photo_id" UUID,
  "item_type" "ItemType" NOT NULL,
  "price_cents" INTEGER NOT NULL,
  CONSTRAINT "order_items_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "order_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "order_items_photo_id_fkey" FOREIGN KEY ("photo_id") REFERENCES "photos"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "audit_logs" (
  "id" BIGSERIAL NOT NULL,
  "user_id" UUID,
  "photo_id" UUID,
  "action" TEXT NOT NULL,
  "data" JSONB,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "audit_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "audit_logs_photo_id_fkey" FOREIGN KEY ("photo_id") REFERENCES "photos"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "face_embeddings" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "photo_id" UUID NOT NULL,
  "event_id" UUID NOT NULL,
  "embedding" DOUBLE PRECISION[] NOT NULL,
  "confidence" DECIMAL(4,3) NOT NULL,
  "bounding_box" JSONB,
  "landmarks" JSONB,
  "estimated_age" INTEGER,
  "estimated_gender" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "face_embeddings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "face_embeddings_photo_id_fkey" FOREIGN KEY ("photo_id") REFERENCES "photos"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "face_embeddings_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "idx_face_embeddings_event" ON "face_embeddings"("event_id");
CREATE INDEX IF NOT EXISTS "idx_face_embeddings_photo" ON "face_embeddings"("photo_id");

CREATE TABLE IF NOT EXISTS "face_bib_associations" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "face_embedding_id" UUID NOT NULL,
  "photo_bib_id" BIGINT NOT NULL,
  "photo_id" UUID NOT NULL,
  "event_id" UUID NOT NULL,
  "bib" TEXT NOT NULL,
  "spatialScore" DECIMAL(4,3) NOT NULL,
  "method" TEXT NOT NULL DEFAULT 'SPATIAL',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "face_bib_associations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "face_bib_associations_face_embedding_id_fkey" FOREIGN KEY ("face_embedding_id") REFERENCES "face_embeddings"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "face_bib_associations_photo_bib_id_fkey" FOREIGN KEY ("photo_bib_id") REFERENCES "photo_bibs"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "face_bib_associations_photo_id_fkey" FOREIGN KEY ("photo_id") REFERENCES "photos"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "face_bib_associations_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "face_bib_associations_face_embedding_id_photo_bib_id_key" ON "face_bib_associations"("face_embedding_id", "photo_bib_id");
CREATE INDEX IF NOT EXISTS "idx_face_bib_assoc_event_bib" ON "face_bib_associations"("event_id", "bib");
CREATE INDEX IF NOT EXISTS "idx_face_bib_assoc_photo" ON "face_bib_associations"("photo_id");

CREATE TABLE IF NOT EXISTS "athlete_signatures" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "event_id" UUID NOT NULL,
  "bib" TEXT NOT NULL,
  "face_signature" DOUBLE PRECISION[] NOT NULL,
  "sampleCount" INTEGER NOT NULL DEFAULT 1,
  "confidence" DECIMAL(4,3) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "athlete_signatures_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "athlete_signatures_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "athlete_signatures_event_id_bib_key" ON "athlete_signatures"("event_id", "bib");
CREATE INDEX IF NOT EXISTS "idx_athlete_signature_event" ON "athlete_signatures"("event_id");

CREATE TABLE IF NOT EXISTS "inferred_bibs" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "photo_id" UUID NOT NULL,
  "face_embedding_id" UUID NOT NULL,
  "event_id" UUID NOT NULL,
  "bib" TEXT NOT NULL,
  "confidence" DECIMAL(4,3) NOT NULL,
  "faceDistance" DECIMAL(4,3) NOT NULL,
  "inferred_from" TEXT NOT NULL,
  "verified" BOOLEAN NOT NULL DEFAULT false,
  "rejected" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "inferred_bibs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "inferred_bibs_photo_id_fkey" FOREIGN KEY ("photo_id") REFERENCES "photos"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "inferred_bibs_face_embedding_id_fkey" FOREIGN KEY ("face_embedding_id") REFERENCES "face_embeddings"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "inferred_bibs_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "inferred_bibs_face_embedding_id_bib_key" ON "inferred_bibs"("face_embedding_id", "bib");
CREATE INDEX IF NOT EXISTS "idx_inferred_bib_photo" ON "inferred_bibs"("photo_id");
CREATE INDEX IF NOT EXISTS "idx_inferred_bib_event_bib" ON "inferred_bibs"("event_id", "bib");
CREATE INDEX IF NOT EXISTS "idx_inferred_bib_event_verified" ON "inferred_bibs"("event_id", "verified");
