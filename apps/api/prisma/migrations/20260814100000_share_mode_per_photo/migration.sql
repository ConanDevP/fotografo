-- Modo compartir: la descarga gratuita se cobra por fotografía subida, no por
-- evento. Las tarifas bajan de un céntimo por foto, de ahí los decimales.

ALTER TABLE "plans" ADD COLUMN "share_photo_cents" DECIMAL(8,4) NOT NULL DEFAULT 0;
ALTER TABLE "workspaces" ADD COLUMN "pending_share_charge_cents" DECIMAL(12,4) NOT NULL DEFAULT 0;
