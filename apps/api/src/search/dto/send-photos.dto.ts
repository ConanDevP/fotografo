import { ArrayMaxSize, ArrayUnique, IsString, IsEmail, IsOptional, IsArray, IsUUID, Matches, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';

export class SendPhotosDto {
  @IsString({ message: 'El dorsal debe ser texto' })
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @Matches(/^\d{1,20}$/, { message: 'El dorsal debe contener entre 1 y 20 dígitos' })
  bib: string;

  @IsEmail({}, { message: 'Email debe ser válido' })
  @Transform(({ value }) => typeof value === 'string' ? value.trim().toLowerCase() : value)
  @MaxLength(254)
  email: string;

  @IsOptional()
  @IsArray({ message: 'Las fotos seleccionadas deben ser un array' })
  @ArrayMaxSize(100)
  @ArrayUnique()
  @IsUUID(4, { each: true, message: 'Cada foto debe ser un UUID válido' })
  selectedPhotos?: string[];
}
