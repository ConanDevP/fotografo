import { Injectable, Logger } from '@nestjs/common';
import { PaymentsService } from '../payments/payments.service';
import { PrismaService } from '../common/services/prisma.service';
import { PaymentGateway, PayPalWebhookEvent } from '@shared/payment-types';

interface MerchantOnboardingWebhook {
  event_type: 'MERCHANT.ONBOARDING.COMPLETED' | 'MERCHANT.PARTNER-CONSENT.REVOKED';
  resource: {
    merchant_id: string;
    tracking_id?: string;
    partner_client_id?: string;
  };
}

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    private readonly paymentsService: PaymentsService,
    private readonly prisma: PrismaService,
  ) {}

  async handlePayPalWebhook(body: PayPalWebhookEvent, headers: any): Promise<{ success: boolean }> {
    try {
      this.logger.log(`Processing PayPal webhook: ${body.event_type}`);
      this.logger.debug('PayPal webhook body:', JSON.stringify(body, null, 2));

      // Handle merchant onboarding webhooks
      if (body.event_type === 'MERCHANT.ONBOARDING.COMPLETED') {
        return await this.handleMerchantOnboardingCompleted(body as any);
      }

      if (body.event_type === 'MERCHANT.PARTNER-CONSENT.REVOKED') {
        return await this.handleMerchantConsentRevoked(body as any);
      }

      // Eventos PayPal de pagos que nos interesan
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

  /**
   * Handle MERCHANT.ONBOARDING.COMPLETED webhook
   * Fired when a photographer completes PayPal onboarding
   */
  private async handleMerchantOnboardingCompleted(body: MerchantOnboardingWebhook): Promise<{ success: boolean }> {
    try {
      const { merchant_id, tracking_id } = body.resource;

      this.logger.log(`Merchant onboarding completed: ${merchant_id}, tracking: ${tracking_id}`);

      if (!merchant_id) {
        this.logger.error('No merchant_id in onboarding webhook');
        return { success: false };
      }

      // Find user by tracking_id or merchant_id
      const user = await this.prisma.user.findFirst({
        where: {
          OR: [
            { paypalTrackingId: tracking_id },
            { paypalMerchantId: merchant_id },
          ],
        },
      });

      if (!user) {
        this.logger.error(`User not found for merchant_id: ${merchant_id}, tracking_id: ${tracking_id}`);
        return { success: false };
      }

      // Update user as onboarding completed
      await this.prisma.user.update({
        where: { id: user.id },
        data: {
          paypalMerchantId: merchant_id,
          paypalOnboardingCompleted: true,
          paypalPermissionsGranted: true,
          paypalOnboardedAt: new Date(),
        },
      });

      this.logger.log(`User ${user.id} marked as PayPal onboarded`);

      return { success: true };

    } catch (error) {
      this.logger.error('Error handling merchant onboarding completed webhook', error);
      return { success: false };
    }
  }

  /**
   * Handle MERCHANT.PARTNER-CONSENT.REVOKED webhook
   * Fired when a photographer revokes permissions
   */
  private async handleMerchantConsentRevoked(body: MerchantOnboardingWebhook): Promise<{ success: boolean }> {
    try {
      const { merchant_id, tracking_id } = body.resource;

      this.logger.log(`Merchant consent revoked: ${merchant_id}, tracking: ${tracking_id}`);

      if (!merchant_id) {
        this.logger.error('No merchant_id in consent revoked webhook');
        return { success: false };
      }

      // Find user by merchant_id
      const user = await this.prisma.user.findFirst({
        where: { paypalMerchantId: merchant_id },
      });

      if (!user) {
        this.logger.error(`User not found for merchant_id: ${merchant_id}`);
        return { success: false };
      }

      // Mark permissions as revoked
      await this.prisma.user.update({
        where: { id: user.id },
        data: {
          paypalPermissionsGranted: false,
          paypalOnboardingCompleted: false,
        },
      });

      this.logger.log(`User ${user.id} PayPal permissions revoked`);

      return { success: true };

    } catch (error) {
      this.logger.error('Error handling merchant consent revoked webhook', error);
      return { success: false };
    }
  }
}