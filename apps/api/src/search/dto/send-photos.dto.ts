import { IsString, IsEmail, IsOptional, IsArray, IsUUID, MinLength } from 'class-validator';

export class SendPhotosDto {
  @IsString({ message: 'El dorsal debe ser texto' })
  @MinLength(1, { message: 'El dorsal no puede estar vacío' })
  bib: string;

  @IsEmail({}, { message: 'Email debe ser válido' })
  email: string;

  @IsOptional()
  @IsArray({ message: 'Las fotos seleccionadas deben ser un array' })
  @IsUUID(4, { each: true, message: 'Cada foto debe ser un UUID válido' })
  selectedPhotos?: string[];
}