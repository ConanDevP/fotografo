import { EnterpriseAccountStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsBoolean, IsDateString, IsEmail, IsEnum, IsInt, IsOptional, IsString, Length, Max, MaxLength, Min } from 'class-validator';

export class UpsertEnterpriseAccountDto {
  @IsEnum(EnterpriseAccountStatus) status: EnterpriseAccountStatus;
  @IsOptional() @IsDateString() contractStart?: string;
  @IsOptional() @IsDateString() contractEnd?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) annualPriceCents?: number;
  @IsOptional() @IsString() @Length(3, 3) currency?: string;
  @IsOptional() @IsString() @MaxLength(200) contractReference?: string;
  @IsOptional() @IsString() @MaxLength(200) legalName?: string;
  @IsOptional() @IsString() @MaxLength(120) accountManager?: string;
  @IsOptional() @IsEmail() businessContactEmail?: string;
  @IsOptional() @IsEmail() technicalContactEmail?: string;
  @IsOptional() @IsEmail() billingContactEmail?: string;
  @IsOptional() @IsEmail() securityContactEmail?: string;
  @IsOptional() @IsString() @MaxLength(3000) internalNotes?: string;
  @IsBoolean() partnerApiEnabled: boolean;
  @IsBoolean() webhooksEnabled: boolean;
  @IsBoolean() faceSearchEnabled: boolean;
  @IsBoolean() sponsorsEnabled: boolean;
  @IsBoolean() customDomainEnabled: boolean;
  @IsBoolean() advancedAnalyticsEnabled: boolean;
  @IsBoolean() exportsEnabled: boolean;
  @IsBoolean() originalDownloadsEnabled: boolean;
  @IsBoolean() sponsoredDownloadsEnabled: boolean;
  @IsBoolean() priorityProcessingEnabled: boolean;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) annualPhotoLimit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) annualEventLimit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) monthlyApiRequestLimit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) monthlyFaceSearchLimit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(1000) maxApiClients?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(1000) maxWebhookEndpoints?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(10000) maxAdmins?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) retentionDays?: number;
}
