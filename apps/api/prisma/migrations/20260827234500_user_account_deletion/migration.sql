-- Cierre de cuenta.
--
-- No se borra la fila: los apuntes contables, los pedidos y el registro de
-- auditoría apuntan a este usuario y hay obligación legal de conservarlos. Lo
-- que se elimina son los datos personales; la fila queda anonimizada y marcada
-- aquí para que el acceso quede cerrado de forma explícita y comprobable.
ALTER TABLE "users" ADD COLUMN "deleted_at" TIMESTAMPTZ(6);

-- Las consultas de acceso preguntan por las cuentas vivas en cada petición.
CREATE INDEX "idx_users_deleted_at" ON "users" ("deleted_at");
