-- Libro de créditos por espacio y registro de llamadas de IA.

CREATE TABLE "usage_ledger" (
    "id" BIGSERIAL NOT NULL,
    "workspace_id" UUID NOT NULL,
    "kind" VARCHAR(32) NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "dedupe_key" TEXT NOT NULL,
    "photo_id" UUID,
    "event_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_ledger_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "usage_ledger_dedupe_key_key" ON "usage_ledger"("dedupe_key");
CREATE INDEX "usage_ledger_workspace_id_kind_created_at_idx" ON "usage_ledger"("workspace_id", "kind", "created_at");

CREATE TABLE "ai_usage_logs" (
    "id" BIGSERIAL NOT NULL,
    "workspace_id" UUID,
    "event_id" UUID,
    "photo_id" UUID,
    "provider" VARCHAR(24) NOT NULL DEFAULT 'GEMINI',
    "model" VARCHAR(80) NOT NULL,
    "strategy" VARCHAR(16) NOT NULL,
    "success" BOOLEAN NOT NULL,
    "bibs_found" INTEGER NOT NULL DEFAULT 0,
    "prompt_tokens" INTEGER,
    "output_tokens" INTEGER,
    "total_tokens" INTEGER,
    "duration_ms" INTEGER,
    "error_code" VARCHAR(80),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_usage_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ai_usage_logs_workspace_id_created_at_idx" ON "ai_usage_logs"("workspace_id", "created_at");
CREATE INDEX "ai_usage_logs_photo_id_idx" ON "ai_usage_logs"("photo_id");
CREATE INDEX "ai_usage_logs_created_at_idx" ON "ai_usage_logs"("created_at");

-- Historial: cada fotografía ya subida cuenta como un crédito en la fecha en que se creó.
-- Es idempotente (la clave de deduplicación es única) y no toca fotografías provisionales.
INSERT INTO "usage_ledger" ("workspace_id", "kind", "quantity", "dedupe_key", "photo_id", "event_id", "created_at")
SELECT p."photographer_workspace_id", 'PHOTO_PROCESSED', 1, 'photo:' || p."id", p."id", p."event_id", p."created_at"
FROM "photos" p
WHERE p."photographer_workspace_id" IS NOT NULL
  AND p."original_url" NOT IN ('pending', 'temp')
ON CONFLICT ("dedupe_key") DO NOTHING;
