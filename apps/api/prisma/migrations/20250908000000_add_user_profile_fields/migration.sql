-- AlterTable
ALTER TABLE "users" ADD COLUMN "name" TEXT,
ADD COLUMN "phone" TEXT,
ADD COLUMN "profile_image_url" TEXT,
ADD COLUMN "address" TEXT,
ADD COLUMN "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now();

-- Update existing records to set updated_at to created_at
UPDATE "users" SET "updated_at" = "created_at" WHERE "updated_at" IS NULL;