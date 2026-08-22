import { IsOptional, IsString, MaxLength } from 'class-validator';

export class RefreshTokenDto {
  @IsOptional()
  @IsString({ message: 'Refresh token debe ser texto' })
  @MaxLength(256)
  refreshToken?: string;
}
