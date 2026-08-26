-- Cobro recurrente: mensualidad del plan vía suscripción de Stripe y
-- liquidación mensual del consumo acumulado del modo compartir.

-- Precio del bloque de almacenamiento adicional, como segunda línea de la
-- suscripción con cantidad igual a los bloques contratados.
ALTER TABLE "plans" ADD COLUMN "stripe_storage_price_id" TEXT;
CREATE UNIQUE INDEX "plans_stripe_storage_price_id_key" ON "plans"("stripe_storage_price_id");

-- Ids de las líneas en Stripe: permiten cambiar plan o cantidad sin re-listar.
ALTER TABLE "subscriptions" ADD COLUMN "stripe_plan_item_id" TEXT;
ALTER TABLE "subscriptions" ADD COLUMN "stripe_storage_item_id" TEXT;

CREATE TYPE "ShareChargeStatus" AS ENUM ('PENDING', 'PAID', 'FAILED');

CREATE TABLE "share_usage_charges" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "period" VARCHAR(7) NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "photos" INTEGER NOT NULL DEFAULT 0,
    "status" "ShareChargeStatus" NOT NULL DEFAULT 'PENDING',
    "failure_reason" TEXT,
    "stripe_payment_intent_id" TEXT,
    "charged_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "share_usage_charges_pkey" PRIMARY KEY ("id")
);

-- Un solo cobro por espacio y periodo: es lo que hace idempotente al cron
-- aunque se dispare dos veces o se reintente tras un fallo.
CREATE UNIQUE INDEX "share_usage_charges_workspace_id_period_key" ON "share_usage_charges"("workspace_id", "period");
CREATE INDEX "share_usage_charges_status_idx" ON "share_usage_charges"("status");

ALTER TABLE "share_usage_charges" ADD CONSTRAINT "share_usage_charges_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
