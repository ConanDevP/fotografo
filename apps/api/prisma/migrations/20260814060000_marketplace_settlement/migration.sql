CREATE TYPE "OrderSettlementStatus" AS ENUM ('PENDING', 'PROCESSING', 'PARTIAL', 'SETTLED', 'FAILED', 'NOT_REQUIRED');

ALTER TABLE "orders"
  ADD COLUMN "stripe_transfer_group" TEXT,
  ADD COLUMN "settlement_status" "OrderSettlementStatus" NOT NULL DEFAULT 'NOT_REQUIRED',
  ADD COLUMN "settlement_error" TEXT,
  ADD COLUMN "settled_at" TIMESTAMPTZ(6),
  ADD COLUMN "stripe_refund_id" TEXT,
  ADD COLUMN "refund_requested_at" TIMESTAMPTZ(6),
  ADD COLUMN "refund_error" TEXT;

ALTER TABLE "ledger_entries"
  ADD COLUMN "external_transfer_id" TEXT,
  ADD COLUMN "external_reversal_id" TEXT,
  ADD COLUMN "paid_out_at" TIMESTAMPTZ(6),
  ADD COLUMN "failure_reason" TEXT;

-- Existing destination-charge orders must not be transferred a second time.
-- New orders created after this migration start pending settlement.
ALTER TABLE "orders" ALTER COLUMN "settlement_status" SET DEFAULT 'PENDING';

CREATE UNIQUE INDEX "ledger_entries_external_transfer_id_key" ON "ledger_entries"("external_transfer_id");
CREATE UNIQUE INDEX "ledger_entries_external_reversal_id_key" ON "ledger_entries"("external_reversal_id");
CREATE UNIQUE INDEX "orders_stripe_refund_id_key" ON "orders"("stripe_refund_id");
CREATE INDEX "orders_settlement_status_idx" ON "orders"("settlement_status");
