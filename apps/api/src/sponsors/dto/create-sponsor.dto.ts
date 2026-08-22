import { IsBoolean, IsOptional, IsString, IsUrl, Matches, MaxLength, MinLength } from 'class-validator';

export class CreateSponsorDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name: string;

  @IsUrl({ require_protocol: true })
  @Matches(/^https:\/\//i, { message: 'El logo debe usar HTTPS' })
  logoUrl: string;

  @IsOptional()
  @IsUrl({ require_protocol: true })
  @Matches(/^https:\/\//i, { message: 'El sitio del patrocinador debe usar HTTPS' })
  websiteUrl?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
