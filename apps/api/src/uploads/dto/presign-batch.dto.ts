import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { FILE_CONSTRAINTS } from '@shared/constants';

export class PresignFileDto {
  /// Identificador estable del archivo en el cliente. Es la clave de
  /// idempotencia: reintentar con el mismo valor no duplica la fotografía.
  @IsString()
  @MaxLength(200)
  clientFileId: string;

  @IsString()
  @MaxLength(255)
  fileName: string;

  @IsIn(FILE_CONSTRAINTS.ALLOWED_TYPES as unknown as string[], {
    message: 'Solo se admiten imágenes JPG o PNG',
  })
  contentType: string;

  /// Tamaño declarado. Sirve para comprobar el cupo antes de firmar; el importe
  /// facturado usa siempre el tamaño verificado contra almacenamiento.
  @IsInt()
  @Min(1)
  @Max(FILE_CONSTRAINTS.MAX_SIZE)
  sizeBytes: number;

  @IsString()
  @Matches(/^[a-f0-9]{64}$/, { message: 'El hash debe ser SHA-256 en hexadecimal' })
  contentHash: string;
}

export class PresignBatchDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50, { message: 'Máximo 50 archivos por solicitud de firma' })
  @ValidateNested({ each: true })
  @Type(() => PresignFileDto)
  files: PresignFileDto[];
}

export class CompleteBatchDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  clientFileIds: string[];
}
