-- Cobro del modo compartir al publicar el evento.
--
-- En modo venta el dinero pasa por la plataforma y la comisión se retiene. En
-- modo compartir no se mueve nada, así que hay que cobrarle al fotógrafo: eso
-- exige una tarjeta guardada. Se pide al publicar el primer evento gratuito,
-- que es cuando nace la obligación, y no al registrarse.

ALTER TABLE "workspaces" ADD COLUMN "stripe_customer_id" TEXT;
ALTER TABLE "workspaces" ADD COLUMN "default_payment_method_id" TEXT;
CREATE UNIQUE INDEX "workspaces_stripe_customer_id_key" ON "workspaces"("stripe_customer_id");

ALTER TABLE "events" ADD COLUMN "share_charge_cents" INTEGER;
ALTER TABLE "events" ADD COLUMN "share_charge_photos" INTEGER;
ALTER TABLE "events" ADD COLUMN "share_charged_at" TIMESTAMPTZ(6);
ALTER TABLE "events" ADD COLUMN "share_charge_intent_id" TEXT;
