-- Registro de corredores por QR: contacto con teléfono, consentimiento, baja y
-- registro de avisos enviados.

ALTER TABLE "events"
  ADD COLUMN "registration_code" VARCHAR(12),
  ADD COLUMN "registration_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "country_code" VARCHAR(2);

CREATE UNIQUE INDEX "events_registration_code_key" ON "events"("registration_code");

ALTER TABLE "bib_subscriptions"
  ALTER COLUMN "email" DROP NOT NULL,
  ADD COLUMN "phone" VARCHAR(20),
  ADD COLUMN "phone_country" VARCHAR(2),
  ADD COLUMN "name" VARCHAR(120),
  ADD COLUMN "locale" VARCHAR(5) NOT NULL DEFAULT 'es',
  ADD COLUMN "source" VARCHAR(16) NOT NULL DEFAULT 'SEARCH',
  ADD COLUMN "status" VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN "email_consent_at" TIMESTAMPTZ(6),
  ADD COLUMN "whatsapp_consent_at" TIMESTAMPTZ(6),
  ADD COLUMN "consent_text_version" VARCHAR(24),
  ADD COLUMN "ip_hash" VARCHAR(64),
  ADD COLUMN "unsubscribed_at" TIMESTAMPTZ(6),
  ADD COLUMN "last_notified_at" TIMESTAMPTZ(6);

-- Las suscripciones anteriores se crearon pidiendo el aviso por correo: ese
-- fue su consentimiento.
UPDATE "bib_subscriptions" SET "email_consent_at" = "created_at" WHERE "email" IS NOT NULL;

ALTER TABLE "bib_subscriptions"
  ADD CONSTRAINT "bib_subscriptions_contact_check" CHECK ("email" IS NOT NULL OR "phone" IS NOT NULL);

-- El unique de (evento, dorsal, correo) no cubre filas sin correo; el teléfono
-- tiene el suyo. Parcial porque la mayoría de filas antiguas no lo tienen.
CREATE UNIQUE INDEX "bib_subscriptions_event_bib_phone_key"
  ON "bib_subscriptions"("event_id", "bib", "phone") WHERE "phone" IS NOT NULL;

CREATE INDEX "bib_subscriptions_event_id_status_idx" ON "bib_subscriptions"("event_id", "status");

CREATE TABLE "bib_notification_log" (
  "id" BIGSERIAL PRIMARY KEY,
  "subscription_id" UUID NOT NULL,
  "photo_id" UUID NOT NULL,
  "channel" VARCHAR(12) NOT NULL,
  "sent_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "bib_notification_log_subscription_id_fkey"
    FOREIGN KEY ("subscription_id") REFERENCES "bib_subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "bib_notification_log_subscription_id_photo_id_channel_key"
  ON "bib_notification_log"("subscription_id", "photo_id", "channel");

-- Quien ya recibió un aviso por foto con el sistema anterior no debe recibir
-- uno nuevo de esas mismas fotos al activar el resumen agrupado.
INSERT INTO "bib_notification_log" ("subscription_id", "photo_id", "channel")
SELECT s."id", pb."photo_id", 'EMAIL'
FROM "bib_subscriptions" s
JOIN "photo_bibs" pb ON pb."event_id" = s."event_id" AND pb."bib" = s."bib"
JOIN "photos" p ON p."id" = pb."photo_id"
WHERE s."email" IS NOT NULL
  AND p."status" = 'PROCESSED' AND p."publication_status" = 'APPROVED'
  AND p."watermark_url" IS NOT NULL
ON CONFLICT DO NOTHING;
