-- Miniatura con marca de agua para las cuadrículas públicas.
--
-- La miniatura existente (thumb_url) se genera sin marca, así que no puede
-- servirse al público. Sin una versión pequeña marcada, la galería del evento
-- cargaba la marca de agua a tamaño completo por cada celda: ~1,6 MB frente a
-- los ~90 KB que ocupa una miniatura.

ALTER TABLE "photos" ADD COLUMN "watermark_thumb_url" TEXT;
