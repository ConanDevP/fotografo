ALTER TABLE "subscriptions"
  ADD COLUMN "admin_granted_until" TIMESTAMPTZ(6),
  ADD COLUMN "admin_grant_reason" TEXT,
  ADD COLUMN "admin_granted_by_id" UUID;

CREATE INDEX "subscriptions_admin_granted_until_idx"
  ON "subscriptions" ("admin_granted_until");
