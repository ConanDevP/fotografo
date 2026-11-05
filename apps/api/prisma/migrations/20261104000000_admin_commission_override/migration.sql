-- Comisión pactada por soporte para una concesión de plan (null = la del plan).
ALTER TABLE "subscriptions" ADD COLUMN "admin_commission_percent" DECIMAL(5,2);
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_admin_commission_percent_range"
  CHECK ("admin_commission_percent" IS NULL OR ("admin_commission_percent" >= 0 AND "admin_commission_percent" <= 100));
