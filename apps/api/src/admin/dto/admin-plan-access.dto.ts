import { IsDateString, IsInt, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
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
}

export class RevokeAdminPlanDto {
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  reason: string;
}
