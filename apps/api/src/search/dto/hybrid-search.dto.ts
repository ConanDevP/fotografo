import { IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';

export class HybridSearchDto {
  @IsOptional()
  @IsString()
  @Matches(/^\d{1,20}$/, { message: 'El dorsal debe contener entre 1 y 20 dígitos' })
  bib?: string;

  @IsOptional()
  @IsString()
  @MaxLength(8_000_000)
  @Matches(/^data:image\/(jpeg|jpg|png|webp);base64,[A-Za-z0-9+/=\r\n]+$/)
  userImageBase64?: string;

  @IsOptional()
  @IsNumber()
  @Min(0.3)
  @Max(0.95)
  threshold?: number;
}
