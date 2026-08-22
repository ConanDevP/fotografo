-- Make commission and earnings accounting safe under duplicate webhooks.
ALTER TABLE "ledger_entries" ADD COLUMN "dedupe_key" TEXT;

DELETE FROM "ledger_entries" duplicate
USING "ledger_entries" keeper
WHERE duplicate."id"::text > keeper."id"::text
  AND duplicate."order_id" = keeper."order_id"
  AND duplicate."type" = keeper."type"
  AND COALESCE(duplicate."workspace_id"::text, '') = COALESCE(keeper."workspace_id"::text, '');

UPDATE "ledger_entries"
SET "dedupe_key" =
  "order_id"::text || ':' || lower("type"::text) || ':' || COALESCE("workspace_id"::text, 'platform');

ALTER TABLE "ledger_entries" ALTER COLUMN "dedupe_key" SET NOT NULL;
CREATE UNIQUE INDEX "ledger_entries_dedupe_key_key" ON "ledger_entries"("dedupe_key");

