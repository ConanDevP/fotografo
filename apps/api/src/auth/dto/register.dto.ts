import { IsEmail, IsString, MinLength, IsOptional, IsIn, MaxLength, Matches } from 'class-validator';
import { Transform } from 'class-transformer';
import { UserRole } from '@shared/types';

export class RegisterDto {
  @IsEmail({}, { message: 'Email debe ser válido' })
  @Transform(({ value }) => typeof value === 'string' ? value.trim().toLowerCase() : value)
  @MaxLength(254)
  email: string;

  @IsString({ message: 'Password debe ser texto' })
  @MinLength(8, { message: 'Password debe tener al menos 8 caracteres' })
  @MaxLength(128, { message: 'Password no puede superar 128 caracteres' })
  password: string;

  @IsOptional()
  @IsString({ message: 'Nombre debe ser texto' })
  @MinLength(2, { message: 'Nombre debe tener al menos 2 caracteres' })
  @MaxLength(100, { message: 'Nombre no puede superar 100 caracteres' })
  name?: string;

  @IsOptional()
  @IsString({ message: 'Teléfono debe ser texto' })
  @MaxLength(20, { message: 'Teléfono no puede superar 20 caracteres' })
  phone?: string;

  @IsOptional()
  @IsString({ message: 'Dirección debe ser texto' })
  @MaxLength(200, { message: 'Dirección no puede superar 200 caracteres' })
  address?: string;

  @IsOptional()
  @IsIn([UserRole.ATHLETE, UserRole.PHOTOGRAPHER], { message: 'Rol debe ser ATHLETE o PHOTOGRAPHER' })
  role?: UserRole;

  /**
   * Dirección pública elegida en la portada (lucilamon.com/{slug}). Si viene
   * ocupada o inválida, el espacio se crea con una variante libre en vez de
   * rechazar el registro.
   */
  @IsOptional()
  @IsString({ message: 'La dirección debe ser texto' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @MinLength(3, { message: 'La dirección debe tener al menos 3 caracteres' })
  @MaxLength(50, { message: 'La dirección no puede superar 50 caracteres' })
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message: 'La dirección solo admite minúsculas, números y guiones',
  })
  slug?: string;
}
