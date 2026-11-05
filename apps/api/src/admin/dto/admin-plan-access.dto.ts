import { IsDateString, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { Type } from 'class-transformer';

export class GrantAdminPlanDto {
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  planSlug: string;

  @IsDateString()
  expiresAt: string;

  @IsString()
  @MinLength(10)
  @MaxLength(500)
  reason: string;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100)
  extraStorageBlocks = 0;

  /// Comisión de plataforma pactada (0 = sin comisión). Vacío = la del plan.
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  commissionPercent?: number;
}

export class RevokeAdminPlanDto {
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  reason: string;
}
