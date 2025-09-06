import { IsEmail, IsString, MinLength, IsOptional, IsEnum } from 'class-validator';
import { UserRole } from '@shared/types';

export class RegisterDto {
  @IsEmail({}, { message: 'Email debe ser válido' })
  email: string;

  @IsString({ message: 'Password debe ser texto' })
  @MinLength(8, { message: 'Password debe tener al menos 8 caracteres' })
  password: string;

  @IsOptional()
  @IsEnum(UserRole, { message: 'Rol debe ser ATHLETE, PHOTOGRAPHER o ADMIN' })
  role?: UserRole;
}