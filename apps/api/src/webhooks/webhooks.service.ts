import { Injectable, Logger } from '@nestjs/common';
import { PaymentsService } from '../payments/payments.service';
import { PaymentGateway, PayPalWebhookEvent } from '@shared/payment-types';

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(private readonly paymentsService: PaymentsService) {}

  async handlePayPalWebhook(body: PayPalWebhookEvent, headers: any): Promise<{ success: boolean }> {
    try {
      this.logger.log(`Processing PayPal webhook: ${body.event_type}`);
      this.logger.debug('PayPal webhook body:', JSON.stringify(body, null, 2));

      // Eventos PayPal que nos interesan
      const relevantEvents = [
        'CHECKOUT.ORDER.APPROVED',
        'PAYMENT.CAPTURE.COMPLETED', 
        'PAYMENT.CAPTURE.DENIED',
        'CHECKOUT.ORDER.CANCELLED',
      ];

      if (!relevantEvents.includes(body.event_type)) {
        this.logger.log(`Ignoring PayPal event: ${body.event_type}`);
        return { success: true };
      }

      // Extraer información del pago
      let paymentId: string;
      let orderStatus: string;

      switch (body.event_type) {
        case 'CHECKOUT.ORDER.APPROVED':
          paymentId = body.resource?.id;
          orderStatus = 'approved';
          break;

        case 'PAYMENT.CAPTURE.COMPLETED':
          // Intentar múltiples rutas para obtener el order ID
          paymentId = body.resource?.supplementary_data?.related_ids?.order_id ||
                     body.resource?.custom_id ||
                     body.resource?.invoice_id ||
                     body.resource?.id;
          orderStatus = 'completed';
          this.logger.log(`Extracted payment ID for CAPTURE.COMPLETED: ${paymentId}`);
          break;

        case 'PAYMENT.CAPTURE.DENIED':
          paymentId = body.resource?.supplementary_data?.related_ids?.order_id ||
                     body.resource?.custom_id ||
                     body.resource?.invoice_id ||
                     body.resource?.id;
          orderStatus = 'denied';
          break;

        case 'CHECKOUT.ORDER.CANCELLED':
          paymentId = body.resource?.id;
          orderStatus = 'cancelled';
          break;

        default:
          this.logger.warn(`Unhandled PayPal event: ${body.event_type}`);
          return { success: true };
      }

      if (!paymentId) {
        this.logger.error('No payment ID found in PayPal webhook');
        this.logger.error('Resource structure:', JSON.stringify(body.resource, null, 2));
        return { success: false };
      }

      // Procesar el pago según el evento
      const result = await this.paymentsService.confirmPaymentFromWebhook(
        paymentId,
        PaymentGateway.PAYPAL,
        body
      );

      this.logger.log(`PayPal webhook processed: ${paymentId}, success: ${result.success}`);
      return result;

    } catch (error) {
      this.logger.error('Error processing PayPal webhook', error);
      return { success: false };
    }
  }

  async handleStripeWebhook(body: any, signature: string): Promise<{ success: boolean }> {
    // TODO: Implementar cuando se agregue Stripe
    this.logger.warn('Stripe webhook handling not implemented');
    return { success: true };
  }

  async handleMercadoPagoWebhook(body: any, headers: any): Promise<{ success: boolean }> {
    // TODO: Implementar cuando se agregue MercadoPago
    this.logger.warn('MercadoPago webhook handling not implemented');
    return { success: true };
  }
}