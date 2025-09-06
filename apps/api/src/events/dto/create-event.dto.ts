import { IsString, IsDateString, IsOptional, IsObject, MinLength } from 'class-validator';
import { BibRules, EventPricing } from '@shared/types';

export class CreateEventDto {
  @IsString({ message: 'El nombre debe ser texto' })
  @MinLength(3, { message: 'El nombre debe tener al menos 3 caracteres' })
  name: string;

  @IsDateString({}, { message: 'La fecha debe ser válida' })
  date: string;

  @IsOptional()
  @IsString({ message: 'La ubicación debe ser texto' })
  location?: string;

  @IsOptional()
  @IsObject({ message: 'Las reglas de dorsal deben ser un objeto' })
  bibRules?: BibRules;

  @IsOptional()
  @IsObject({ message: 'Los precios deben ser un objeto' })
  pricing?: EventPricing;
}