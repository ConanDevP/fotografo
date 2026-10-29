-- Facturación del contrato Enterprise: exceso de cupo y facturas emitidas.

ALTER TABLE "enterprise_accounts"
  ADD COLUMN "allow_overage" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "overage_photo_cents" DECIMAL(8,4),
  ADD COLUMN "invoice_days_due" INTEGER NOT NULL DEFAULT 30;

CREATE TABLE "enterprise_invoices" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "kind" VARCHAR(16) NOT NULL,
    "period_key" VARCHAR(64) NOT NULL,
    "units" INTEGER NOT NULL DEFAULT 0,
    "amount_cents" INTEGER NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'USD',
    "status" VARCHAR(16) NOT NULL DEFAULT 'PENDING',
    "stripe_invoice_id" TEXT,
    "error" VARCHAR(500),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "enterprise_invoices_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "enterprise_invoices_stripe_invoice_id_key" ON "enterprise_invoices"("stripe_invoice_id");
CREATE UNIQUE INDEX "enterprise_invoices_workspace_id_kind_period_key_key" ON "enterprise_invoices"("workspace_id", "kind", "period_key");
CREATE INDEX "enterprise_invoices_status_idx" ON "enterprise_invoices"("status");
