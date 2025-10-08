-- Migration: add_paypal_marketplace_fields
-- ✅ SEGURA: Solo agrega columnas, NO borra nada

-- 1. Agregar campos PayPal a la tabla users
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "paypal_merchant_id" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "paypal_merchant_id_in_paypal" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "paypal_email" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "paypal_onboarding_completed" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "paypal_permissions_granted" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "paypal_tracking_id" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "paypal_onboarded_at" TIMESTAMPTZ;

-- 2. Crear constraint UNIQUE en paypal_merchant_id (si no existe)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'users_paypal_merchant_id_key'
    ) THEN
        ALTER TABLE "users" ADD CONSTRAINT "users_paypal_merchant_id_key" UNIQUE ("paypal_merchant_id");
    END IF;
END $$;

-- 3. Agregar campo platform_fee_percent a la tabla events
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "platform_fee_percent" DECIMAL(5,2) DEFAULT 15.00;
