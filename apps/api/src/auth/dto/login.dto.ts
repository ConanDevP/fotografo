import { IsEmail, IsString, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';

export class LoginDto {
  @IsEmail({}, { message: 'Email debe ser válido' })
  @Transform(({ value }) => typeof value === 'string' ? value.trim().toLowerCase() : value)
  @MaxLength(254)
  email: string;

  @IsString({ message: 'Password debe ser texto' })
  @MaxLength(128, { message: 'Password no puede superar 128 caracteres' })
  password: string;
}
