-- El organizador elige si el QR de registro usa su dominio propio o lucilamon.com.
ALTER TABLE "events" ADD COLUMN "registration_use_custom_domain" BOOLEAN NOT NULL DEFAULT false;
