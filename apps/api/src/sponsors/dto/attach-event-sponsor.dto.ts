import { IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsUUID, Max, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

class SponsorPlacementDto {
  @IsOptional()
  @IsIn(['top', 'bottom'])
  position?: 'top' | 'bottom';

  @IsOptional()
  @IsNumber()
  @Min(0.35)
  @Max(1)
  opacity?: number;

  @IsOptional()
  @IsNumber()
  @Min(2)
  @Max(20)
  maxHeightPercent?: number;
}

export class AttachEventSponsorDto {
  @IsUUID()
  sponsorId: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  priority?: number;

  @IsOptional()
  @IsBoolean()
  requiredOnFreeDownloads?: boolean;

  @IsOptional()
  @ValidateNested()
  @Type(() => SponsorPlacementDto)
  placement?: SponsorPlacementDto;
}
