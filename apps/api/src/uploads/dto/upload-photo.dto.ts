import { IsString, IsOptional, IsDateString, IsUUID } from 'class-validator';

export class UploadPhotoDto {
  @IsString({ message: 'EventId debe ser texto' })
  @IsUUID(4, { message: 'EventId debe ser un UUID válido' })
  eventId: string;

  @IsOptional()
  @IsDateString({}, { message: 'TakenAt debe ser una fecha válida' })
  takenAt?: string;
}