import { ArrayMinSize, IsArray, IsDateString, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { PARTNER_API_SCOPES, PartnerApiScope } from '../partner-api.scopes';

export class CreateApiClientDto {
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name: string;

  @IsArray()
  @ArrayMinSize(1)
  @IsIn(PARTNER_API_SCOPES, { each: true })
  scopes: PartnerApiScope[];

  @IsOptional()
  @IsDateString()
  expiresAt?: string;
}

export class RotateApiClientDto {
  @IsOptional()
  @IsDateString()
  expiresAt?: string;
}
