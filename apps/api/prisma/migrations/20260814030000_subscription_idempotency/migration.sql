-- Prevent duplicate subscriptions and duplicate notification emails.
DELETE FROM "bib_subscriptions" duplicate
USING "bib_subscriptions" keeper
WHERE duplicate."id" > keeper."id"
  AND duplicate."event_id" = keeper."event_id"
  AND duplicate."bib" = keeper."bib"
  AND lower(duplicate."email") = lower(keeper."email");

UPDATE "bib_subscriptions" SET "email" = lower(trim("email"));

CREATE UNIQUE INDEX "bib_subscriptions_event_id_bib_email_key"
  ON "bib_subscriptions"("event_id", "bib", "email");

