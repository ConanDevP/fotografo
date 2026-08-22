DELETE FROM "event_contributors" older
USING "event_contributors" newer
WHERE older."event_id" = newer."event_id"
  AND lower(older."invited_email") = lower(newer."invited_email")
  AND (
    older."updated_at" < newer."updated_at"
    OR (older."updated_at" = newer."updated_at" AND older."id" < newer."id")
  );

UPDATE "event_contributors"
SET "invited_email" = lower(trim("invited_email"));

CREATE UNIQUE INDEX "event_contributors_event_id_invited_email_key"
  ON "event_contributors"("event_id", "invited_email");
