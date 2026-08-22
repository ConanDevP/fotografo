ALTER TABLE "orders"
ADD COLUMN "access_token_expires_at" TIMESTAMPTZ(6);

UPDATE "orders"
SET "access_token_expires_at" = "created_at" + INTERVAL '30 days'
WHERE "access_token_hash" IS NOT NULL;
