import { IsString, MaxLength, MinLength } from 'class-validator';

export class ChangePasswordDto {
  @IsString()
  @MinLength(1, { message: 'Introduce tu contraseña actual' })
  @MaxLength(128)
  currentPassword: string;

  @IsString()
  @MinLength(8, { message: 'La nueva contraseña debe tener al menos 8 caracteres' })
  @MaxLength(128, { message: 'La nueva contraseña no puede superar 128 caracteres' })
  newPassword: string;
}
