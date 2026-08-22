import {
  IsBoolean,
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { UpdateBrandThemeDto } from './update-brand-theme.dto';

export class CreateWorkspaceDto {

  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name: string;

  @IsOptional()
  @IsString()
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  @MaxLength(80)
  slug?: string;

  @IsOptional()
  @IsString()
  @MaxLength(800)
  description?: string;

  @IsOptional()
  @IsUrl({ require_protocol: true })
  @Matches(/^https:\/\//i, { message: 'El logo debe usar HTTPS' })
  logoUrl?: string;

  @IsOptional()
  @IsUrl({ require_protocol: true })
  @Matches(/^https:\/\//i, { message: 'La portada debe usar HTTPS' })
  coverUrl?: string;

  @IsOptional()
  @IsString()
  @Matches(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/)
  customDomain?: string | null;

  @IsOptional()
  @IsEmail()
  contactEmail?: string;

  @IsOptional()
  @IsUrl({ require_protocol: true })
  @Matches(/^https:\/\//i, { message: 'El sitio web debe usar HTTPS' })
  website?: string;

  @IsOptional()
  @IsUrl({ require_protocol: true })
  @Matches(/^https:\/\//i, { message: 'Instagram debe ser una URL HTTPS' })
  instagram?: string;

  @IsOptional()
  @IsUrl({ require_protocol: true })
  @Matches(/^https:\/\//i, { message: 'Facebook debe ser una URL HTTPS' })
  facebook?: string;

  @IsOptional()
  @IsBoolean()
  isPublished?: boolean;

  @IsOptional()
  @ValidateNested()
  @Type(() => UpdateBrandThemeDto)
  brand?: UpdateBrandThemeDto;
}
