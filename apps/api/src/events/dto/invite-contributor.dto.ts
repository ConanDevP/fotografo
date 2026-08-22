import { IsEmail, IsEnum, IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { EventContributorRole } from '@prisma/client';

export class InviteContributorDto {
  @IsEmail()
  email: string;

  @IsOptional()
  @IsEnum(EventContributorRole)
  role?: EventContributorRole;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  organizerCommissionPercent?: number;

  @IsOptional()
  @IsString()
  @MaxLength(3000)
  rightsTerms?: string;
}

