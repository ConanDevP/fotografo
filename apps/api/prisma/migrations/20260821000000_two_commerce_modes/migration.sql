-- Dos modos de entrega, según quién paga.
--
--   PAID  → paga el atleta; la plataforma retiene comisión por venta.
--   FREE  → el atleta no paga; paga el fotógrafo por fotografía subida.
--
-- Se retiran tres modos:
--
--   SPONSORED_FREE  era idéntico a FREE. Quien decide si se estampan los logos
--                   es `sponsor_overlay_enabled`, no el modo, así que ofrecía
--                   dos opciones indistinguibles.
--   HYBRID          permitía cobrar y regalar a la vez, lo que dejaba ambiguo
--                   quién paga el evento.
--   PRIVATE         solo excluía el evento de todas las consultas públicas y no
--                   tenía ningún mecanismo de acceso: quedaba invisible incluso
--                   para sus atletas. Eso ya lo hace `is_published = false`.

-- 1. Reasignar antes de tocar el tipo.
--    Los patrocinados conservan sus logos mediante el interruptor que ya existía.
UPDATE "events" SET "sponsor_overlay_enabled" = true WHERE "commerce_mode" = 'SPONSORED_FREE';
UPDATE "events" SET "commerce_mode" = 'FREE' WHERE "commerce_mode" = 'SPONSORED_FREE';

--    Los híbridos pasan a venta: conservan sus precios y no empiezan a generar
--    de golpe un cargo por fotografía que su dueño no había aceptado.
UPDATE "events" SET "commerce_mode" = 'PAID' WHERE "commerce_mode" = 'HYBRID';

--    Los privados eran borradores ocultos; siguen sin publicar.
UPDATE "events" SET "commerce_mode" = 'FREE', "is_published" = false WHERE "commerce_mode" = 'PRIVATE';

-- 2. Rehacer el tipo. Postgres no permite quitar valores de un enum, y el
--    DEFAULT depende de él, así que hay que soltarlo primero.
ALTER TABLE "events" ALTER COLUMN "commerce_mode" DROP DEFAULT;
ALTER TABLE "events" ALTER COLUMN "commerce_mode" TYPE TEXT USING "commerce_mode"::text;
DROP TYPE "EventCommerceMode";
CREATE TYPE "EventCommerceMode" AS ENUM ('PAID', 'FREE');
ALTER TABLE "events" ALTER COLUMN "commerce_mode" TYPE "EventCommerceMode" USING "commerce_mode"::"EventCommerceMode";
ALTER TABLE "events" ALTER COLUMN "commerce_mode" SET DEFAULT 'PAID';
