import { IsString, IsOptional, MaxLength, MinLength } from 'class-validator';

export class UpdateProfileDto {
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
}