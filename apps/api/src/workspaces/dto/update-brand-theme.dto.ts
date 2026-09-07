import { IsBoolean, IsHexColor, IsIn, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateBrandThemeDto {
  @IsOptional()
  @IsString()
  @IsIn(['editorial', 'impact', 'minimal', 'cine'])
  @MaxLength(40)
  template?: string;

  @IsOptional()
  @IsHexColor()
  primaryColor?: string;

  @IsOptional()
  @IsHexColor()
  secondaryColor?: string;

  @IsOptional()
  @IsHexColor()
  accentColor?: string;

  @IsOptional()
  @IsString()
  @IsIn([
    // Pares display + cuerpo actuales.
    'grotesque', 'sport', 'editorial-serif', 'classic', 'neutral',
    // Valores heredados, se siguen aceptando y se mapean en el frontend.
    'Inter', 'Geist', 'Playfair Display',
  ])
  @MaxLength(80)
  fontFamily?: string;

  @IsOptional()
  @IsString()
  @MaxLength(140)
  heroTitle?: string;

  @IsOptional()
  @IsString()
  @MaxLength(320)
  heroSubtitle?: string;

  @IsOptional()
  @IsBoolean()
  showPastEvents?: boolean;

  @IsOptional()
  @IsObject()
  settings?: Record<string, unknown>;
}
