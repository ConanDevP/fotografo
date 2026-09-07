-- Ciclo de vida de la invitación a colaborador de evento: fechas explícitas
-- de caducidad, último envío, aceptación, rechazo y revocación.
-- Columnas nullable → alta instantánea, sin reescritura ni bloqueo.
ALTER TABLE "event_contributors"
  ADD COLUMN IF NOT EXISTS "expires_at" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "last_invited_at" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "accepted_at" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "declined_at" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "revoked_at" TIMESTAMPTZ(6);

-- El índice (invited_email, status) que necesita el panel del invitado ya existe
-- desde 20260814000000_multitenant_foundation.
