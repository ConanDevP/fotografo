import { IsString, IsNumber, IsOptional, IsArray, Min, Max } from 'class-validator';

export class AddBibDto {
  @IsString({ message: 'El dorsal debe ser texto' })
  bib: string;

  @IsOptional()
  @IsNumber({}, { message: 'La confianza debe ser un número' })
  @Min(0, { message: 'La confianza debe ser mayor a 0' })
  @Max(1, { message: 'La confianza debe ser menor a 1' })
  confidence?: number;

  @IsOptional()
  @IsArray({ message: 'El bbox debe ser un array' })
  bbox?: [number, number, number, number];
}