-- Contracargos.
--
-- Un reembolso lo decidimos nosotros; un contracargo lo decide el banco del
-- comprador. Sin atenderlo, Stripe retiraba el importe y su comisión de disputa
-- mientras la transferencia al fotógrafo seguía en pie: se perdía dos veces.

ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'DISPUTED';
ALTER TYPE "LedgerEntryType" ADD VALUE IF NOT EXISTS 'DISPUTE';
ALTER TYPE "LedgerEntryType" ADD VALUE IF NOT EXISTS 'DISPUTE_FEE';

ALTER TABLE "orders" ADD COLUMN "stripe_dispute_id" TEXT;
ALTER TABLE "orders" ADD COLUMN "disputed_at" TIMESTAMPTZ(6);
ALTER TABLE "orders" ADD COLUMN "dispute_outcome" TEXT;
ALTER TABLE "orders" ADD COLUMN "refund_policy_accepted_at" TIMESTAMPTZ(6);
CREATE UNIQUE INDEX "orders_stripe_dispute_id_key" ON "orders"("stripe_dispute_id");
