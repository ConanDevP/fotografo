import { IsEmail, IsString, MinLength, MaxLength } from 'class-validator';

export class ForgotPasswordDto {
  @IsEmail({}, { message: 'Introduce un email válido' })
  email: string;
}

export class ResetPasswordWithTokenDto {
  @IsString()
  @MinLength(32, { message: 'El enlace no es válido' })
  @MaxLength(128)
  token: string;

  // Exactamente las mismas reglas que el registro. Pedir aquí más de lo que se
  // pidió al crear la cuenta dejaría a gente sin poder reponer su contraseña.
  @IsString()
  @MinLength(8, { message: 'La contraseña debe tener al menos 8 caracteres' })
  @MaxLength(128, { message: 'La contraseña no puede superar 128 caracteres' })
  password: string;
}
