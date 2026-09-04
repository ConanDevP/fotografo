CREATE TABLE "partner_idempotency_records" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "api_client_id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "key" VARCHAR(200) NOT NULL,
  "operation" VARCHAR(80) NOT NULL,
  "request_hash" VARCHAR(64) NOT NULL,
  "response" JSONB,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "partner_idempotency_records_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "partner_idempotency_records_api_client_id_fkey"
    FOREIGN KEY ("api_client_id") REFERENCES "api_clients"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "partner_idempotency_records_api_client_id_key_key"
  ON "partner_idempotency_records"("api_client_id", "key");
CREATE INDEX "partner_idempotency_records_expires_at_idx"
  ON "partner_idempotency_records"("expires_at");
