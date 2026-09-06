-- Analítica: enriquecimiento de la captura + capa de agregación.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Columnas nuevas en la captura cruda. Todas nullable o con default constante,
--    así que Postgres las añade sin reescribir la tabla ni bloquear escrituras.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "metric_events"
  ADD COLUMN IF NOT EXISTS "day_visitor_hash" TEXT,
  ADD COLUMN IF NOT EXISTS "channel" TEXT,
  ADD COLUMN IF NOT EXISTS "device" TEXT,
  ADD COLUMN IF NOT EXISTS "country" VARCHAR(2),
  ADD COLUMN IF NOT EXISTS "is_internal" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "is_bot" BOOLEAN NOT NULL DEFAULT false;

-- El único índice sobre una tabla que ya puede ser grande.
-- Si "metric_events" tiene volumen, créalo ANTES de aplicar esta migración con:
--     CREATE INDEX CONCURRENTLY "metric_events_workspace_id_is_bot_created_at_idx"
--       ON "metric_events" ("workspace_id", "is_bot", "created_at");
-- (ver prisma/migrations/metric_events_analytics_index.sql). El IF NOT EXISTS de
-- abajo lo detecta y no hace nada. En una tabla pequeña esta línea es instantánea.
CREATE INDEX IF NOT EXISTS "metric_events_workspace_id_is_bot_created_at_idx"
  ON "metric_events" ("workspace_id", "is_bot", "created_at");

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Rollup diario de métricas.
--    Grano: día × espacio × evento × tipo. Las filas de nivel espacio llevan
--    event_id NULL y event_key = UUID cero (sin FK a events).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "metric_daily_rollup" (
  "id" BIGSERIAL NOT NULL,
  "day" DATE NOT NULL,
  "workspace_id" UUID NOT NULL,
  "event_id" UUID,
  "event_key" UUID NOT NULL,
  "metric_type" "MetricType" NOT NULL,
  "count" INTEGER NOT NULL DEFAULT 0,
  "unique_visitors" INTEGER NOT NULL DEFAULT 0,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "metric_daily_rollup_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "metric_daily_rollup_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE,
  CONSTRAINT "metric_daily_rollup_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "metric_daily_rollup_day_workspace_id_event_key_metric_type_key"
  ON "metric_daily_rollup" ("day", "workspace_id", "event_key", "metric_type");
CREATE INDEX IF NOT EXISTS "metric_daily_rollup_workspace_id_day_idx" ON "metric_daily_rollup" ("workspace_id", "day");
CREATE INDEX IF NOT EXISTS "metric_daily_rollup_event_id_day_idx" ON "metric_daily_rollup" ("event_id", "day");

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Instantánea analítica por evento (una fila, recalculada).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "event_analytics_snapshot" (
  "event_id" UUID NOT NULL,
  "workspace_id" UUID,
  "total_photos" INTEGER NOT NULL DEFAULT 0,
  "processed_photos" INTEGER NOT NULL DEFAULT 0,
  "photos_with_bib" INTEGER NOT NULL DEFAULT 0,
  "photos_with_face" INTEGER NOT NULL DEFAULT 0,
  "photos_no_bib" INTEGER NOT NULL DEFAULT 0,
  "distinct_bibs" INTEGER NOT NULL DEFAULT 0,
  "distinct_inferred_bibs" INTEGER NOT NULL DEFAULT 0,
  "field_size" INTEGER,
  "bibs_searched" INTEGER NOT NULL DEFAULT 0,
  "bibs_with_sale" INTEGER NOT NULL DEFAULT 0,
  "event_views" INTEGER NOT NULL DEFAULT 0,
  "photo_views" INTEGER NOT NULL DEFAULT 0,
  "unique_visitors" INTEGER NOT NULL DEFAULT 0,
  "bib_searches" INTEGER NOT NULL DEFAULT 0,
  "face_searches" INTEGER NOT NULL DEFAULT 0,
  "no_result_searches" INTEGER NOT NULL DEFAULT 0,
  "add_to_cart" INTEGER NOT NULL DEFAULT 0,
  "checkout_started" INTEGER NOT NULL DEFAULT 0,
  "purchases" INTEGER NOT NULL DEFAULT 0,
  "free_downloads" INTEGER NOT NULL DEFAULT 0,
  "paid_downloads" INTEGER NOT NULL DEFAULT 0,
  "gross_cents" INTEGER NOT NULL DEFAULT 0,
  "net_platform_cents" INTEGER NOT NULL DEFAULT 0,
  "organizer_commission_cents" INTEGER NOT NULL DEFAULT 0,
  "photographer_earning_cents" INTEGER NOT NULL DEFAULT 0,
  "refund_cents" INTEGER NOT NULL DEFAULT 0,
  "sponsor_impressions" INTEGER NOT NULL DEFAULT 0,
  "sponsor_clicks" INTEGER NOT NULL DEFAULT 0,
  "top_countries" JSONB,
  "device_split" JSONB,
  "channel_split" JSONB,
  "daily_series" JSONB,
  "report_sent_at" TIMESTAMPTZ(6),
  "report_token_version" INTEGER NOT NULL DEFAULT 1,
  "computed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "event_analytics_snapshot_pkey" PRIMARY KEY ("event_id"),
  CONSTRAINT "event_analytics_snapshot_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "event_analytics_snapshot_workspace_id_idx" ON "event_analytics_snapshot" ("workspace_id");

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Rollup diario por patrocinador.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "sponsor_daily_rollup" (
  "id" BIGSERIAL NOT NULL,
  "day" DATE NOT NULL,
  "sponsor_id" UUID NOT NULL,
  "event_id" UUID,
  "event_key" UUID NOT NULL,
  "impressions" INTEGER NOT NULL DEFAULT 0,
  "clicks" INTEGER NOT NULL DEFAULT 0,
  "unique_reach" INTEGER NOT NULL DEFAULT 0,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "sponsor_daily_rollup_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "sponsor_daily_rollup_sponsor_id_fkey" FOREIGN KEY ("sponsor_id") REFERENCES "sponsors"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "sponsor_daily_rollup_day_sponsor_id_event_key_key"
  ON "sponsor_daily_rollup" ("day", "sponsor_id", "event_key");
CREATE INDEX IF NOT EXISTS "sponsor_daily_rollup_sponsor_id_day_idx" ON "sponsor_daily_rollup" ("sponsor_id", "day");

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Ajustes de otras tablas.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "workspaces"
  ADD COLUMN IF NOT EXISTS "post_event_reports_enabled" BOOLEAN NOT NULL DEFAULT true;
