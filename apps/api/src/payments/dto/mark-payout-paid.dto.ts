import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { PAYOUT_METHODS, PayoutMethod } from '../manual-payouts.service';

export class MarkPayoutPaidDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @IsUUID('4', { each: true })
  entryIds: string[];

  @IsIn([...PAYOUT_METHODS])
  method: PayoutMethod;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  reference: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
