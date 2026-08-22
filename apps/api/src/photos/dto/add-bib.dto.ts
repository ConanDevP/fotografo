import { ArrayMaxSize, ArrayMinSize, IsString, IsNumber, IsOptional, IsArray, Matches, Min, Max } from 'class-validator';

export class AddBibDto {
  @IsString({ message: 'El dorsal debe ser texto' })
  @Matches(/^\d{1,20}$/, { message: 'El dorsal debe contener entre 1 y 20 dígitos' })
  bib: string;

  @IsOptional()
  @IsNumber({}, { message: 'La confianza debe ser un número' })
  @Min(0, { message: 'La confianza debe ser mayor a 0' })
  @Max(1, { message: 'La confianza debe ser menor a 1' })
  confidence?: number;

  @IsOptional()
  @IsArray({ message: 'El bbox debe ser un array' })
  @ArrayMinSize(4)
  @ArrayMaxSize(4)
  @IsNumber({}, { each: true })
  bbox?: [number, number, number, number];
}
