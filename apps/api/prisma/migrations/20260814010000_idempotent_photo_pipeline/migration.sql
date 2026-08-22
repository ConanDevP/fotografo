-- Make every uploaded file and every processing stage safely retryable.

CREATE TYPE "BatchUploadItemStatus" AS ENUM (
  'RECEIVED', 'PROCESSING', 'COMPLETED', 'FAILED', 'DUPLICATE'
);

ALTER TABLE "photos"
  ADD COLUMN "derivatives_processed_at" TIMESTAMPTZ(6),
  ADD COLUMN "ocr_processed_at" TIMESTAMPTZ(6),
  ADD COLUMN "face_processed_at" TIMESTAMPTZ(6),
  ADD COLUMN "processing_completed_at" TIMESTAMPTZ(6),
  ADD COLUMN "watermark_failed_at" TIMESTAMPTZ(6),
  ADD COLUMN "ocr_failed_at" TIMESTAMPTZ(6),
  ADD COLUMN "face_failed_at" TIMESTAMPTZ(6);

CREATE TABLE "batch_upload_items" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "batch_job_id" UUID NOT NULL,
  "client_file_id" TEXT NOT NULL,
  "photo_id" UUID,
  "file_name" TEXT NOT NULL,
  "content_hash" TEXT,
  "status" "BatchUploadItemStatus" NOT NULL DEFAULT 'RECEIVED',
  "error" TEXT,
  "derivatives_processed_at" TIMESTAMPTZ(6),
  "ocr_processed_at" TIMESTAMPTZ(6),
  "face_processed_at" TIMESTAMPTZ(6),
  "watermark_failed_at" TIMESTAMPTZ(6),
  "ocr_failed_at" TIMESTAMPTZ(6),
  "face_failed_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "batch_upload_items_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "batch_upload_items_batch_job_id_fkey"
    FOREIGN KEY ("batch_job_id") REFERENCES "batch_upload_jobs"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "batch_upload_items_photo_id_fkey"
    FOREIGN KEY ("photo_id") REFERENCES "photos"("id")
    ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "batch_upload_items_batch_job_id_client_file_id_key"
  ON "batch_upload_items"("batch_job_id", "client_file_id");
CREATE INDEX "batch_upload_items_photo_id_idx" ON "batch_upload_items"("photo_id");
CREATE INDEX "batch_upload_items_batch_job_id_status_idx"
  ON "batch_upload_items"("batch_job_id", "status");

-- Preserve visibility of legacy batches. Exact stage timestamps become authoritative
-- for every photo processed after this migration.
INSERT INTO "batch_upload_items" (
  "batch_job_id", "client_file_id", "photo_id", "file_name", "content_hash", "status"
)
SELECT
  p."batch_job_id",
  'legacy-' || p."id"::text,
  p."id",
  'legacy-' || p."id"::text,
  p."content_hash",
  CASE
    WHEN p."status" = 'PROCESSED' THEN 'COMPLETED'::"BatchUploadItemStatus"
    WHEN p."status" = 'FAILED' THEN 'FAILED'::"BatchUploadItemStatus"
    ELSE 'PROCESSING'::"BatchUploadItemStatus"
  END
FROM "photos" p
WHERE p."batch_job_id" IS NOT NULL
ON CONFLICT ("batch_job_id", "client_file_id") DO NOTHING;

UPDATE "photos"
SET
  "derivatives_processed_at" = CASE
    WHEN "thumb_url" IS NOT NULL AND "watermark_url" IS NOT NULL THEN "created_at" ELSE NULL END,
  "processing_completed_at" = CASE
    WHEN "status" = 'PROCESSED' THEN "created_at" ELSE NULL END;

