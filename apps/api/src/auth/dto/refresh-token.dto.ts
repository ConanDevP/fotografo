import { IsString } from 'class-validator';

export class RefreshTokenDto {
  @IsString({ message: 'Refresh token debe ser texto' })
  refreshToken: string;
}