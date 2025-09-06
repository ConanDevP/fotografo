import { IsString, IsOptional, IsEnum } from 'class-validator';

export class ReprocessPhotoDto {
  @IsOptional()
  @IsEnum(['flash', 'pro'], { message: 'Estrategia debe ser flash o pro' })
  strategy?: 'flash' | 'pro' = 'pro';
}