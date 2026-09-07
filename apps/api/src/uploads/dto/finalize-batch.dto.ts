import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsString, MaxLength, ValidateNested } from 'class-validator';

export class SkippedBatchFileDto {
  @IsString()
  @MaxLength(200)
  clientFileId: string;

  @IsString()
  @MaxLength(255)
  fileName: string;

  @IsString()
  @MaxLength(1000)
  reason: string;
}

export class FinalizeBatchDto {
  @IsArray()
  @ArrayMaxSize(5000)
  @ValidateNested({ each: true })
  @Type(() => SkippedBatchFileDto)
  skipped: SkippedBatchFileDto[];
}
