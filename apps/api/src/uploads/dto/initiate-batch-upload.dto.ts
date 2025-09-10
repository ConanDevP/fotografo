import { IsInt, IsUUID, Min } from 'class-validator';

export class InitiateBatchUploadDto {
  @IsUUID(4, { message: 'El eventId debe ser un UUID válido' })
  eventId: string;

  @IsInt({ message: 'totalFiles debe ser un número entero' })
  @Min(1, { message: 'totalFiles debe ser al menos 1' })
  totalFiles: number;
}
