-- Server-side lifecycle metrics must not duplicate when a gateway retries.
ALTER TABLE "metric_events" ADD COLUMN "dedupe_key" TEXT;
CREATE UNIQUE INDEX "metric_events_dedupe_key_key" ON "metric_events"("dedupe_key");

