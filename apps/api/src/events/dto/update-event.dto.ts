import { IsBoolean, IsDateString, IsEnum, IsNumber, IsOptional, IsString, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { EventCommerceMode } from '@shared/types';
import { BibRulesDto, EventPricingDto } from './event-configuration.dto';

export class UpdateEventDto {
  @IsOptional()
  @IsString({ message: 'El nombre debe ser texto' })
  @MinLength(3, { message: 'El nombre debe tener al menos 3 caracteres' })
  @MaxLength(160)
  name?: string;

  @IsOptional()
  @IsDateString({}, { message: 'La fecha debe ser válida' })
  date?: string;

  @IsOptional()
  @IsString({ message: 'La ubicación debe ser texto' })
  @MaxLength(240)
  location?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => BibRulesDto)
  bibRules?: BibRulesDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => EventPricingDto)
  pricing?: EventPricingDto;

  @IsOptional()
  @IsEnum(EventCommerceMode)
  commerceMode?: EventCommerceMode;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  organizerCommissionPercent?: number;

  @IsOptional()
  @IsBoolean()
  sponsorOverlayEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  requiresPhotoApproval?: boolean;

  @IsOptional()
  @IsBoolean()
  isPublished?: boolean;
}
