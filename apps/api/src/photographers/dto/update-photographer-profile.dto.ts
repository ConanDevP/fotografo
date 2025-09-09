import { 
  IsString, 
  IsOptional, 
  IsUrl, 
  IsArray, 
  IsInt, 
  IsBoolean,
  MinLength, 
  MaxLength, 
  Min, 
  Max, 
  Matches,
  ArrayMaxSize
} from 'class-validator';
import { Transform } from 'class-transformer';

export class UpdatePhotographerProfileDto {
  @IsOptional()
  @IsString({ message: 'Slug debe ser texto' })
  @MinLength(3, { message: 'Slug debe tener al menos 3 caracteres' })
  @MaxLength(50, { message: 'Slug no puede superar 50 caracteres' })
  @Matches(/^[a-z0-9-]+$/, { message: 'Slug solo puede contener letras minúsculas, números y guiones' })
  @Transform(({ value }) => value?.toLowerCase().trim())
  slug?: string;

  @IsOptional()
  @IsString({ message: 'Biografía debe ser texto' })
  @MaxLength(1000, { message: 'Biografía no puede superar 1000 caracteres' })
  @Transform(({ value }) => value?.trim())
  bio?: string;

  @IsOptional()
  @IsUrl({}, { message: 'Website debe ser una URL válida' })
  @MaxLength(255, { message: 'Website no puede superar 255 caracteres' })
  website?: string;

  @IsOptional()
  @IsString({ message: 'Instagram debe ser texto' })
  @MaxLength(50, { message: 'Instagram no puede superar 50 caracteres' })
  @Matches(/^[a-zA-Z0-9_.]+$/, { message: 'Instagram solo puede contener letras, números, puntos y guiones bajos' })
  @Transform(({ value }) => value?.toLowerCase().trim())
  instagram?: string;

  @IsOptional()
  @IsString({ message: 'Facebook debe ser texto' })
  @MaxLength(100, { message: 'Facebook no puede superar 100 caracteres' })
  @Transform(({ value }) => value?.trim())
  facebook?: string;

  @IsOptional()
  @IsArray({ message: 'Especialidades debe ser un array' })
  @IsString({ each: true, message: 'Cada especialidad debe ser texto' })
  @ArrayMaxSize(10, { message: 'Máximo 10 especialidades permitidas' })
  @Transform(({ value }) => Array.isArray(value) ? value.map(v => v.trim().toLowerCase()) : value)
  specialties?: string[];

  @IsOptional()
  @IsInt({ message: 'Años de experiencia debe ser un número entero' })
  @Min(0, { message: 'Años de experiencia no puede ser negativo' })
  @Max(50, { message: 'Años de experiencia no puede superar 50' })
  experienceYears?: number;

  @IsOptional()
  @IsString({ message: 'Ubicación debe ser texto' })
  @MaxLength(100, { message: 'Ubicación no puede superar 100 caracteres' })
  @Transform(({ value }) => value?.trim())
  location?: string;

  @IsOptional()
  @IsUrl({}, { message: 'Portfolio URL debe ser una URL válida' })
  @MaxLength(255, { message: 'Portfolio URL no puede superar 255 caracteres' })
  portfolioUrl?: string;
}