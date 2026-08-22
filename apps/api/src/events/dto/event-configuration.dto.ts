import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Transform } from 'class-transformer';

export class EventPricingDto {
  @IsInt()
  @Min(1)
  @Max(100_000_000)
  singlePhoto: number;

  @IsInt()
  @Min(1)
  @Max(100_000_000)
  pack5: number;

  @IsInt()
  @Min(1)
  @Max(100_000_000)
  pack10: number;

  @IsInt()
  @Min(1)
  @Max(100_000_000)
  allPhotos: number;

  @IsString()
  @Transform(({ value }) => typeof value === 'string' ? value.trim().toUpperCase() : value)
  @Matches(/^[A-Z]{3}$/)
  currency: string;
}

export class BibRulesDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  minLen?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  maxLen?: number;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  regex?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsString({ each: true })
  @MaxLength(20, { each: true })
  whitelist?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(2)
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(1_000_000_000, { each: true })
  range?: [number, number];
}
