import { IsString, IsEmail, MinLength } from 'class-validator';

export class SubscribeToBibDto {
  @IsString({ message: 'El dorsal debe ser texto' })
  @MinLength(1, { message: 'El dorsal no puede estar vacío' })
  bib: string;

  @IsEmail({}, { message: 'Email debe ser válido' })
  email: string;
}