import { Controller, Post, Body, Headers, Logger, HttpCode, HttpStatus } from '@nestjs/common';
import { WebhooksService } from './webhooks.service';

@Controller('webhooks')
export class WebhooksController {
  private readonly logger = new Logger(WebhooksController.name);

  constructor(private readonly webhooksService: WebhooksService) { }

  @Post('stripe')
  @HttpCode(HttpStatus.OK)
  async handleStripeWebhook(
    @Body() body: Buffer,
    @Headers('stripe-signature') signature: string,
  ) {
    try {
      if (!body || body.length === 0) {
        this.logger.error('Stripe webhook: No body available');
        return { received: true, error: 'No body' };
      }

      if (!signature) {
        this.logger.error('Stripe webhook: No signature header');
        return { received: true, error: 'No signature' };
      }

      this.logger.log('Received Stripe webhook');

      const result = await this.webhooksService.handleStripeWebhook(body, signature);

      return { received: true, processed: result.success };
    } catch (error) {
      this.logger.error('Error processing Stripe webhook', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return { received: true, error: errorMessage };
    }
  }

  /* PayPal comentado temporalmente
  @Post('paypal')
  @HttpCode(HttpStatus.OK)
  async handlePayPalWebhook(
    @Body() body: any,
    @Headers() headers: any,
  ) {
    try {
      this.logger.log('Received PayPal webhook', { eventType: body?.event_type });

      // Validar que el body no esté vacío
      if (!body || !body.event_type) {
        this.logger.warn('PayPal webhook received with invalid body');
        return { received: true, error: 'Invalid webhook body' };
      }

      const result = await this.webhooksService.handlePayPalWebhook(body, headers);

      return { received: true, processed: result.success };
    } catch (error) {
      this.logger.error('Error processing PayPal webhook', error);
      // PayPal espera un 200 incluso si hay errores para no reintentar
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return { received: true, error: errorMessage };
    }
  }
  */

  @Post('mercadopago')
  @HttpCode(HttpStatus.OK)
  async handleMercadoPagoWebhook(
    @Body() body: any,
    @Headers() headers: any,
  ) {
    try {
      this.logger.log('Received MercadoPago webhook', { type: body?.type });

      // TODO: Implementar cuando se agregue MercadoPago
      return { received: true, processed: false };
    } catch (error) {
      this.logger.error('Error processing MercadoPago webhook', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return { received: true, error: errorMessage };
    }
  }
}