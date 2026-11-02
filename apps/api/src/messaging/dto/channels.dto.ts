import { Transform } from 'class-transformer';
import { IsBoolean, IsEmail, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const emptyToUndefined = ({ value }: { value: unknown }) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);

export class ConnectEmailDto {
  /** Clave de API de Resend del cliente (empieza por `re_`). */
  @IsString()
  @Transform(trim)
  @Matches(/^re_[A-Za-z0-9_-]{10,200}$/, { message: 'La clave de Resend debe empezar por «re_»' })
  apiKey: string;

  @IsEmail({}, { message: 'El remitente debe ser un correo válido' })
  @MaxLength(254)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  fromEmail: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  @Transform(emptyToUndefined)
  fromName?: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  @Transform(({ value }) => (typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : undefined))
  replyTo?: string;
}

export class UpdateEmailSettingsDto {
  @IsOptional()
  @IsBoolean()
  fallbackToPlatform?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  @Transform(emptyToUndefined)
  fromName?: string;

  @IsOptional()
  @IsEmail()
  @Transform(({ value }) => (typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : undefined))
  replyTo?: string;
}

export class ConnectWhatsAppDto {
  @IsString()
  @Transform(trim)
  @MinLength(20, { message: 'El token de acceso parece incompleto' })
  @MaxLength(1000)
  @Matches(/^\S+$/, { message: 'El token no debe llevar espacios' })
  accessToken: string;

  /** ID del número de teléfono (WhatsApp Manager → Herramientas de API). */
  @IsString()
  @Transform(trim)
  @Matches(/^\d{5,30}$/, { message: 'El ID del número son solo dígitos' })
  phoneId: string;

  /** ID de la cuenta de WhatsApp Business. */
  @IsString()
  @Transform(trim)
  @Matches(/^\d{5,30}$/, { message: 'El ID de la cuenta son solo dígitos' })
  wabaId: string;
}

export class TestEmailDto {
  @IsEmail()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  to: string;
}

export class TestWhatsAppDto {
  @IsString()
  @MaxLength(32)
  @Transform(trim)
  phone: string;

  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z]{2}$/)
  country?: string;
}

export class ConfirmTestDto {
  @IsBoolean()
  worked: boolean;
}
