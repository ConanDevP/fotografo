import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsOptional, IsString, IsUrl, MaxLength } from 'class-validator';
import { PARTNER_WEBHOOK_EVENTS, PartnerWebhookEvent } from '../partner-webhook.events';

export class CreatePartnerWebhookDto {
  @IsUrl({ protocols: ['https'], require_protocol: true, require_tld: true })
  @MaxLength(2048)
  url: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(PARTNER_WEBHOOK_EVENTS.length)
  @IsIn(PARTNER_WEBHOOK_EVENTS, { each: true })
  events: PartnerWebhookEvent[];
}

export class UpdatePartnerWebhookDto {
  @IsOptional()
  @IsUrl({ protocols: ['https'], require_protocol: true, require_tld: true })
  @MaxLength(2048)
  url?: string;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(PARTNER_WEBHOOK_EVENTS.length)
  @IsIn(PARTNER_WEBHOOK_EVENTS, { each: true })
  events?: PartnerWebhookEvent[];

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
