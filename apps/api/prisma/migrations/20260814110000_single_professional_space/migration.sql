-- Un solo tipo de espacio profesional.
--
-- La separación fotógrafo/organizador no protegía ninguna capacidad: ambos
-- roles aparecían siempre juntos en los mismos permisos. Lo que distingue a un
-- organizador ya está en los datos —posee eventos que fotografían otros— vía
-- Event.workspaceId, Photo.photographerWorkspaceId y EventContributor.
--
-- Además, filtrar por type='PHOTOGRAPHER' al subir dejaba sin espacio a quien
-- se registró como organizador, y con ello sin cupo, sin medición y sin
-- beneficiario. Quitar la columna cierra ese agujero de forma definitiva.

-- 1. Reasignar los datos existentes antes de tocar los tipos.
UPDATE "users" SET "role" = 'PHOTOGRAPHER' WHERE "role" = 'ORGANIZER';

-- 2. Quitar la columna type de workspaces (y su índice).
DROP INDEX IF EXISTS "workspaces_type_is_published_idx";
ALTER TABLE "workspaces" DROP COLUMN "type";
DROP TYPE IF EXISTS "WorkspaceType";
CREATE INDEX "workspaces_is_published_idx" ON "workspaces"("is_published");

-- 3. Recrear UserRole sin ORGANIZER. Postgres no permite eliminar valores de
--    un enum, así que se pasa la columna por texto y se rehace el tipo. Se evita
--    el renombrado porque dentro de una misma transacción el nombre reutilizado
--    sigue resolviendo al tipo antiguo.
-- El índice parcial lleva el enum en su predicado, así que hay que soltarlo
-- antes de tocar el tipo y volver a crearlo después.
DROP INDEX IF EXISTS "idx_users_role_featured";

ALTER TABLE "users" ALTER COLUMN "role" TYPE TEXT USING "role"::text;
DROP TYPE "UserRole";
CREATE TYPE "UserRole" AS ENUM ('ATHLETE', 'PHOTOGRAPHER', 'ADMIN');
ALTER TABLE "users" ALTER COLUMN "role" TYPE "UserRole" USING "role"::"UserRole";

CREATE INDEX "idx_users_role_featured" ON "users" ("role", "is_featured")
  WHERE "role" = 'PHOTOGRAPHER'::"UserRole";
