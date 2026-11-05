import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { RECOVERY_METHODS, RecoveryMethod } from '../manual-payouts.service';

export class MarkPayoutRecoveredDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @IsUUID('4', { each: true })
  entryIds: string[];

  @IsIn([...RECOVERY_METHODS])
  method: RecoveryMethod;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  reference?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
