import { IsString, IsOptional, IsNumber, Min, Max, IsNotEmpty } from 'class-validator';
import { Transform } from 'class-transformer';

export class FaceSearchDto {
  @IsString()
  @IsNotEmpty()
  userImageBase64: string;

  @IsOptional()
  @IsNumber()
  @Min(0.3)
  @Max(0.95)
  @Transform(({ value }) => parseFloat(value))
  threshold?: number;
}

export class FaceSearchStatsDto {
  @IsOptional()
  @IsString()
  eventId?: string;
}