import { IsInt, IsOptional, IsString, Matches, Max, Min } from 'class-validator';

export class ChangePlanDto {
  @IsString()
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message: 'El identificador del plan no es válido',
  })
  planSlug: string;

  @IsOptional()
  @IsInt({ message: 'Los bloques adicionales deben ser un número entero' })
  @Min(0)
  @Max(100, { message: 'Contacta con soporte para ampliaciones mayores' })
  extraStorageBlocks?: number;
}
