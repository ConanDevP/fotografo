import { Controller, Post, Body, Headers } from '@nestjs/common';
import { WebhooksService } from './webhooks.service';

@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly webhooksService: WebhooksService) {}

  @Post('stripe')
  async handleStripeWebhook(
    @Body() body: any,
    @Headers('stripe-signature') signature: string,
  ) {
    // TODO: Implement Stripe webhook handling when not in demo mode
    return { received: true };
  }
}