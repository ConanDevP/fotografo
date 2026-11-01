import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, Matches } from 'class-validator';

export class UpdateRegistrationConfigDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  /** Usar el dominio propio del espacio en el QR. Requiere que esté verificado. */
  @IsOptional()
  @IsBoolean()
  useCustomDomain?: boolean;

  /** País del evento: país por defecto del selector de teléfono. */
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z]{2}$/)
  @Transform(({ value }) => (typeof value === 'string' ? value.toUpperCase() : value))
  countryCode?: string;
}
