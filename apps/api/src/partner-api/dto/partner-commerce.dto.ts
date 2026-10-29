import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsDateString, IsInt, IsIn, IsObject, IsOptional, IsString, IsUUID, Max, MaxLength, Min, ValidateNested } from 'class-validator';

export const PARTNER_ORDER_STATUSES = ['PAID', 'REFUNDED', 'DISPUTED', 'CREATED', 'CANCELLED'] as const;

/** Métricas de audiencia que un servidor puede enviar. Las de compra salen de los pedidos, no de aquí. */
export const PARTNER_METRIC_TYPES = [
  'EVENT_VIEW', 'PHOTO_VIEW', 'BIB_SEARCH', 'FACE_SEARCH', 'SEARCH_NO_RESULTS', 'ADD_TO_CART', 'CHECKOUT_STARTED', 'SPONSOR_CLICK',
] as const;

export class PartnerOrderListQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 50;
  @IsOptional() @IsUUID() eventId?: string;
  @IsOptional() @IsIn(PARTNER_ORDER_STATUSES) status?: (typeof PARTNER_ORDER_STATUSES)[number];
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
}

export class PartnerEarningsQueryDto {
  @IsOptional() @IsUUID() eventId?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit = 50;
}

export class PartnerDateRangeQueryDto {
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
}

export class PartnerVisitorDto {
  @IsOptional() @IsString() @MaxLength(64) ip?: string;
  @IsOptional() @IsString() @MaxLength(512) userAgent?: string;
  @IsOptional() @IsString() @MaxLength(2) country?: string;
  @IsOptional() @IsString() @MaxLength(2048) referrer?: string;
}

export class PartnerMetricDto {
  @IsIn(PARTNER_METRIC_TYPES) type: (typeof PARTNER_METRIC_TYPES)[number];
  @IsOptional() @IsUUID() photoId?: string;
  @IsOptional() @IsString() @MaxLength(120) sessionId?: string;
  @IsOptional() @IsString() @MaxLength(120) source?: string;
  @IsOptional() @IsObject() metadata?: Record<string, unknown>;
  @IsOptional() @ValidateNested() @Type(() => PartnerVisitorDto) visitor?: PartnerVisitorDto;
}

export class PartnerMetricsBatchDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => PartnerMetricDto) events: PartnerMetricDto[];
}
