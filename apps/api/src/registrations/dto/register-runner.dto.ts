import { Transform } from 'class-transformer';
import { IsBoolean, IsEmail, IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class RegisterRunnerDto {
  @IsString({ message: 'El dorsal debe ser texto' })
  @Transform(trim)
  @Matches(/^\d{1,20}$/, { message: 'El dorsal debe contener entre 1 y 20 dígitos' })
  bib: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  @Transform(trim)
  name?: string;

  @IsOptional()
  @IsEmail({}, { message: 'El correo no es válido' })
  @MaxLength(254)
  @Transform(({ value }) => (typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : undefined))
  email?: string;

  @IsOptional()
  @IsBoolean()
  emailConsent?: boolean;

  /** Número nacional o internacional. Con `phoneCountry` basta el nacional. */
  @IsOptional()
  @IsString()
  @MaxLength(32)
  @Transform(({ value }) => (typeof value === 'string' && value.trim() ? value.trim() : undefined))
  phone?: string;

  /** País del número (ISO 3166-1 alfa-2). */
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z]{2}$/)
  phoneCountry?: string;

  @IsOptional()
  @IsBoolean()
  whatsappConsent?: boolean;

  @IsOptional()
  @IsIn(['es', 'en'])
  locale?: 'es' | 'en';

  /** Campo trampa: lo rellenan los robots, no las personas. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  website?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  turnstileToken?: string;
}
