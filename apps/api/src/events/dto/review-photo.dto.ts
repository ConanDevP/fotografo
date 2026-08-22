import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { PhotoPublicationStatus } from '@prisma/client';

export class ReviewPhotoDto {
  @IsEnum(PhotoPublicationStatus)
  status: PhotoPublicationStatus;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

