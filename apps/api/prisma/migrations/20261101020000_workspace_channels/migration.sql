-- Canales de aviso propios de cada espacio (Resend y WhatsApp Business del cliente)
-- y registro de los avisos que no salieron.

CREATE TABLE "workspace_channels" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL,
  "channel" VARCHAR(12) NOT NULL,
  "status" VARCHAR(12) NOT NULL DEFAULT 'PENDING',
  "config" JSONB NOT NULL DEFAULT '{}',
  "secret_enc" TEXT NOT NULL,
  "secret_hint" VARCHAR(12),
  "last_checked_at" TIMESTAMPTZ(6),
  "last_error_code" VARCHAR(40),
  "last_error_message" VARCHAR(600),
  "last_alert_at" TIMESTAMPTZ(6),
  "last_alert_code" VARCHAR(40),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "workspace_channels_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "workspace_channels_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "workspace_channels_workspace_id_channel_key" ON "workspace_channels"("workspace_id", "channel");

CREATE TABLE "delivery_issues" (
  "id" BIGSERIAL PRIMARY KEY,
  "workspace_id" UUID NOT NULL,
  "event_id" UUID,
  "subscription_id" UUID,
  "channel" VARCHAR(12) NOT NULL,
  "scope" VARCHAR(12) NOT NULL,
  "code" VARCHAR(40) NOT NULL,
  "message" VARCHAR(600) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

CREATE INDEX "delivery_issues_workspace_id_created_at_idx" ON "delivery_issues"("workspace_id", "created_at");
CREATE INDEX "delivery_issues_event_id_created_at_idx" ON "delivery_issues"("event_id", "created_at");
