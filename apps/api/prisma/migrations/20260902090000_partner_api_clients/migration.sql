CREATE TABLE "api_clients" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL,
  "created_by_id" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "key_prefix" VARCHAR(32) NOT NULL,
  "secret_hash" VARCHAR(64) NOT NULL,
  "scopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "environment" VARCHAR(16) NOT NULL DEFAULT 'LIVE',
  "expires_at" TIMESTAMPTZ(6),
  "last_used_at" TIMESTAMPTZ(6),
  "revoked_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "api_clients_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "api_clients_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "api_clients_key_prefix_key" ON "api_clients"("key_prefix");
CREATE INDEX "api_clients_workspace_id_revoked_at_idx" ON "api_clients"("workspace_id", "revoked_at");
CREATE INDEX "api_clients_created_by_id_idx" ON "api_clients"("created_by_id");
