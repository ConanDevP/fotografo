-- CreateIndex for photographer profile fields
-- Migration: 20250909000000_add_photographer_profile_fields

-- Add new fields to users table for photographer profiles
ALTER TABLE "users" ADD COLUMN "slug" VARCHAR(100);
ALTER TABLE "users" ADD COLUMN "bio" TEXT;
ALTER TABLE "users" ADD COLUMN "website" VARCHAR(255);
ALTER TABLE "users" ADD COLUMN "instagram" VARCHAR(100);
ALTER TABLE "users" ADD COLUMN "facebook" VARCHAR(100);
ALTER TABLE "users" ADD COLUMN "specialties" TEXT[];
ALTER TABLE "users" ADD COLUMN "experience_years" INTEGER;
ALTER TABLE "users" ADD COLUMN "location" VARCHAR(255);
ALTER TABLE "users" ADD COLUMN "portfolio_url" VARCHAR(255);
ALTER TABLE "users" ADD COLUMN "is_featured" BOOLEAN DEFAULT false;
ALTER TABLE "users" ADD COLUMN "is_verified" BOOLEAN DEFAULT false;

-- Create unique constraint on slug (after ensuring no conflicts)
ALTER TABLE "users" ADD CONSTRAINT "users_slug_key" UNIQUE ("slug");

-- Create indexes for performance
CREATE INDEX "idx_users_slug" ON "users"("slug") WHERE "slug" IS NOT NULL;
CREATE INDEX "idx_users_role_featured" ON "users"("role", "is_featured") WHERE "role" = 'PHOTOGRAPHER';
CREATE INDEX "idx_users_specialties" ON "users" USING GIN ("specialties") WHERE "specialties" IS NOT NULL;
CREATE INDEX "idx_users_location" ON "users"("location") WHERE "location" IS NOT NULL;