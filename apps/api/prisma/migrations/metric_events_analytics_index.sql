-- Índice de analítica sobre "metric_events".
--
-- La migración 20260906000000_analytics_rollups lo crea con un CREATE INDEX
-- normal, que en una tabla grande bloquea las escrituras mientras se construye.
-- Si "metric_events" ya tiene volumen en producción, ejecuta ESTO ANTES de
-- aplicar la migración (fuera de cualquier transacción, con psql directo):
--
--     psql "$DATABASE_URL" -f apps/api/prisma/migrations/metric_events_analytics_index.sql
--
-- Luego `prisma migrate deploy` verá que el índice ya existe (IF NOT EXISTS) y
-- no hará nada.

CREATE INDEX CONCURRENTLY IF NOT EXISTS "metric_events_workspace_id_is_bot_created_at_idx"
  ON "metric_events" ("workspace_id", "is_bot", "created_at");
