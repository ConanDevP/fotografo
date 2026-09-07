CREATE TABLE "stripe_webhook_events" (
  "id" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processed_at" TIMESTAMPTZ(6),
  CONSTRAINT "stripe_webhook_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "stripe_webhook_events_processed_at_idx"
  ON "stripe_webhook_events"("processed_at");
