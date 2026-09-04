import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsDateString, IsEmail, IsEnum, IsInt, IsNumber, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from 'class-validator';
import { EventCommerceMode } from '@shared/types';
import { Type } from 'class-transformer';
import { PhotoPublicationStatus } from '@prisma/client';

export class CreatePartnerUploadBatchDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5000)
  totalFiles: number;
}

export class PartnerListQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 50;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  status?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  publicationStatus?: string;

  @IsOptional()
  @Matches(/^(true|false)$/)
  archived?: string;
}

export class PartnerBibSearchQueryDto {
  @IsString()
  @Matches(/^\d{1,20}$/)
  bib: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 50;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string;
}

export class PartnerFaceSearchDto {
  @IsString()
  @MaxLength(8_000_000)
  @Matches(/^data:image\/(jpeg|jpg|png|webp);base64,[A-Za-z0-9+/=\r\n]+$/)
  userImageBase64: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.3)
  @Max(0.95)
  threshold?: number;
}

export class PartnerDownloadDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(60)
  @Max(900)
  expiresIn = 300;
}

export class PartnerFreeDownloadDto {
  @IsOptional() @IsEmail() @MaxLength(254) email?: string;
  @IsOptional() @IsString() @MaxLength(120) name?: string;
  @IsOptional() @IsString() @MaxLength(40) phone?: string;
  @IsOptional() @IsString() @MaxLength(40) bibNumber?: string;
}

export class PartnerLowConfidenceQueryDto extends PartnerListQueryDto {
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) @Max(1) threshold = 0.8;
}

export class PartnerBulkReviewDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @IsUUID('4', { each: true }) photoIds: string[];
  @IsEnum(PhotoPublicationStatus) status: PhotoPublicationStatus;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

export class PartnerBulkPhotoIdsDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @IsUUID('4', { each: true }) photoIds: string[];
}

export class PartnerBulkDownloadDto extends PartnerBulkPhotoIdsDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(60) @Max(900) expiresIn = 300;
}

export class PartnerGalleryConfigDto {
  @IsOptional() @IsBoolean() isPublished?: boolean;
  @IsOptional() @IsEnum(EventCommerceMode) commerceMode?: EventCommerceMode;
  @IsOptional() @IsBoolean() isFreeDownload?: boolean;
  @IsOptional() @IsDateString() freeDownloadUntil?: string | null;
  @IsOptional() @IsBoolean() requireEmailForFree?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(1000) freeDownloadLimit?: number | null;
  @IsOptional() @IsBoolean() sponsorOverlayEnabled?: boolean;
  @IsOptional() @IsBoolean() requiresPhotoApproval?: boolean;
}
