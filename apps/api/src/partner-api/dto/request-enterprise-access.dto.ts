import { IsEmail, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class RequestEnterpriseAccessDto {
  /** Para qué quieren la API. Es lo que el equipo comercial necesita para triar. */
  @IsString()
  @MinLength(10)
  @MaxLength(1000)
  useCase: string;

  /** Volumen aproximado, en texto libre. Ej: "≈5.000 fotos/mes". */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  monthlyVolume?: string;

  /** Tipo de integración. Ej: "sistema de cronometraje", "web propia". */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  integrationType?: string;

  /** A dónde contestar. Por defecto, el correo de quien solicita. */
  @IsOptional()
  @IsEmail()
  contactEmail?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  message?: string;
}
