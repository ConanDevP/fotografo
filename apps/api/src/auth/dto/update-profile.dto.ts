import { IsString, IsOptional, MaxLength, MinLength, IsUrl, Matches } from 'class-validator';
import { Transform } from 'class-transformer';

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

  // Nuevos campos opcionales para perfiles básicos
  @IsOptional()
  @IsString({ message: 'Slug debe ser texto' })
  @MinLength(3, { message: 'Slug debe tener al menos 3 caracteres' })
  @MaxLength(50, { message: 'Slug no puede superar 50 caracteres' })
  @Matches(/^[a-z0-9-]+$/, { message: 'Slug solo puede contener letras minúsculas, números y guiones' })
  @Transform(({ value }) => value?.toLowerCase().trim())
  slug?: string;

  @IsOptional()
  @IsString({ message: 'Biografía debe ser texto' })
  @MaxLength(500, { message: 'Biografía no puede superar 500 caracteres' })
  @Transform(({ value }) => value?.trim())
  bio?: string;

  @IsOptional()
  @IsUrl({}, { message: 'Website debe ser una URL válida' })
  @MaxLength(255, { message: 'Website no puede superar 255 caracteres' })
  website?: string;

  @IsOptional()
  @IsString({ message: 'Ubicación debe ser texto' })
  @MaxLength(100, { message: 'Ubicación no puede superar 100 caracteres' })
  @Transform(({ value }) => value?.trim())
  location?: string;
}