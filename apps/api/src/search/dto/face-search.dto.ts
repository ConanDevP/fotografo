import { IsString, IsOptional, IsNumber, Min, Max, IsNotEmpty, Matches, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';

export class FaceSearchDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(8_000_000)
  @Matches(/^data:image\/(jpeg|jpg|png|webp);base64,[A-Za-z0-9+/=\r\n]+$/)
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
