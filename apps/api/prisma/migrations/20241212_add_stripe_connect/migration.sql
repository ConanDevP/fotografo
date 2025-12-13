-- Add Stripe Connect fields to users table
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "stripe_account_id" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "stripe_account_status" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "stripe_onboarding_completed" BOOLEAN DEFAULT false;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "stripe_charges_enabled" BOOLEAN DEFAULT false;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "stripe_payouts_enabled" BOOLEAN DEFAULT false;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "stripe_onboarded_at" TIMESTAMPTZ;

-- Create unique index on stripe_account_id
CREATE UNIQUE INDEX IF NOT EXISTS "users_stripe_account_id_key" ON "users"("stripe_account_id");
