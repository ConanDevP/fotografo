CREATE TABLE "partner_webhook_endpoints" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(), "workspace_id" UUID NOT NULL,
  "api_client_id" UUID NOT NULL, "url" VARCHAR(2048) NOT NULL,
  "secret_encrypted" TEXT NOT NULL, "events" TEXT[] NOT NULL, "active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "partner_webhook_endpoints_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "partner_webhook_endpoints_api_client_id_fkey" FOREIGN KEY ("api_client_id") REFERENCES "api_clients"("id") ON DELETE CASCADE
);
CREATE INDEX "partner_webhook_endpoints_workspace_id_active_idx" ON "partner_webhook_endpoints"("workspace_id", "active");

CREATE TABLE "partner_webhook_deliveries" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(), "endpoint_id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL, "event_id" UUID NOT NULL, "event_type" VARCHAR(100) NOT NULL,
  "payload" JSONB NOT NULL, "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING', "attempts" INTEGER NOT NULL DEFAULT 0,
  "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "response_status" INTEGER,
  "last_error" VARCHAR(1000), "delivered_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "partner_webhook_deliveries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "partner_webhook_deliveries_endpoint_id_fkey" FOREIGN KEY ("endpoint_id") REFERENCES "partner_webhook_endpoints"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "partner_webhook_deliveries_endpoint_id_event_id_key" ON "partner_webhook_deliveries"("endpoint_id", "event_id");
CREATE INDEX "partner_webhook_deliveries_status_next_attempt_at_idx" ON "partner_webhook_deliveries"("status", "next_attempt_at");
CREATE INDEX "partner_webhook_deliveries_workspace_id_created_at_idx" ON "partner_webhook_deliveries"("workspace_id", "created_at");
