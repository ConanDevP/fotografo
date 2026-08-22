import { Injectable, Logger, Optional } from '@nestjs/common';
import { PaymentsService } from '../payments/payments.service';
import { PrismaService } from '../common/services/prisma.service';
import { StripeGatewayService } from '../payments/gateways/stripe-gateway.service';
import { StripeConnectService } from '../payments/gateways/stripe-connect.service';
import { PaymentGateway } from '@shared/payment-types';
import Stripe from 'stripe';

/* PayPal comentado temporalmente
interface MerchantOnboardingWebhook {
  event_type: 'MERCHANT.ONBOARDING.COMPLETED' | 'MERCHANT.PARTNER-CONSENT.REVOKED';
  resource: {
    merchant_id: string;
    tracking_id?: string;
    partner_client_id?: string;
  };
}
*/

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    private readonly paymentsService: PaymentsService,
    private readonly prisma: PrismaService,
    @Optional() private readonly stripeGateway: StripeGatewayService,
    @Optional() private readonly stripeConnect: StripeConnectService,
  ) { }

  /* PayPal comentado temporalmente
  async handlePayPalWebhook(body: any, headers: any): Promise<{ success: boolean }> {
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
  */

  async handleStripeWebhook(rawBody: Buffer | string, signature: string): Promise<{ success: boolean }> {
    try {
      if (!this.stripeGateway) {
        this.logger.warn('Stripe not configured, ignoring webhook');
        return { success: true };
      }

      // Verify and construct event
      let event: Stripe.Event;
      try {
        event = this.stripeGateway.constructWebhookEvent(rawBody, signature);
      } catch (err) {
        this.logger.error('Stripe webhook signature verification failed', err);
        return { success: false };
      }

      this.logger.log(`Processing Stripe webhook: ${event.type}`);

      this.logger.debug(`Stripe webhook verificado: ${event.id}`);

      switch (event.type) {
        // Payment events
        case 'checkout.session.completed': {
          const session = event.data.object as Stripe.Checkout.Session;
          this.logger.log(`Checkout session completed: ${session.id}, payment_status: ${session.payment_status}, metadata: ${JSON.stringify(session.metadata)}`);

          if (session.payment_status === 'paid') {
            this.logger.log(`Processing paid session ${session.id}...`);
            const result = await this.paymentsService.confirmPaymentFromWebhook(
              session.id,
              PaymentGateway.STRIPE,
              event
            );
            if (!result.success) throw new Error(`No se pudo confirmar la sesión ${session.id}`);
            this.logger.log(`Successfully confirmed payment for session ${session.id}`);
          } else {
            this.logger.log(`Session ${session.id} not paid yet, status: ${session.payment_status}`);
          }
          break;
        }

        case 'checkout.session.expired': {
          const session = event.data.object as Stripe.Checkout.Session;
          this.logger.log(`Checkout session expired: ${session.id}`);
          // Optionally mark order as cancelled
          break;
        }

        // Connect account events
        case 'account.updated': {
          const account = event.data.object as Stripe.Account;
          if (this.stripeConnect) {
            await this.stripeConnect.handleAccountUpdated(account);
          }
          break;
        }

        case 'account.application.deauthorized': {
          const application = event.data.object as Stripe.Application;
          this.logger.log(`Application deauthorized: ${application.id}`);
          // Handle account disconnection if needed
          break;
        }

        // ── Contracargos ────────────────────────────────────────────────
        // El banco del comprador retiene el importe. Hay que recuperar lo ya
        // transferido al fotógrafo y responder con la prueba de entrega antes
        // de que venza el plazo.
        case 'charge.dispute.created': {
          const dispute = event.data.object as Stripe.Dispute;
          this.logger.warn(`Contracargo abierto: ${dispute.id} (${dispute.amount} ${dispute.currency})`);
          await this.paymentsService.handleDisputeOpened({
            disputeId: dispute.id,
            chargeId: typeof dispute.charge === 'string' ? dispute.charge : dispute.charge.id,
            amountCents: dispute.amount,
            feeCents: Math.abs(
              dispute.balance_transactions?.reduce((sum, item) => sum + (item.fee || 0), 0) || 0,
            ),
            reason: dispute.reason,
          });
          break;
        }

        case 'charge.dispute.closed': {
          const dispute = event.data.object as Stripe.Dispute;
          await this.paymentsService.handleDisputeClosed(dispute.id, dispute.status);
          break;
        }

        // Payment intent events (for more granular tracking)
        case 'payment_intent.succeeded': {
          const paymentIntent = event.data.object as Stripe.PaymentIntent;
          this.logger.log(`Payment intent succeeded: ${paymentIntent.id}`);

          if (paymentIntent.metadata?.orderId) {
            const orderId = paymentIntent.metadata.orderId;
            const result = await this.paymentsService.confirmStripeIntentFromWebhook({
              orderId,
              paymentIntentId: paymentIntent.id,
              amountReceived: paymentIntent.amount_received,
              currency: paymentIntent.currency,
            });
            if (!result.success) throw new Error(`No se pudo confirmar el PaymentIntent ${paymentIntent.id}`);
          } else {
            this.logger.warn('PaymentIntent sin orderId en metadata');
          }
          break;
        }

        case 'payment_intent.payment_failed': {
          const paymentIntent = event.data.object as Stripe.PaymentIntent;
          this.logger.log(`Payment intent failed: ${paymentIntent.id}`);
          break;
        }

        // Transfer events (for Connect payouts)
        case 'transfer.created': {
          const transfer = event.data.object as Stripe.Transfer;
          this.logger.log(`Transfer created: ${transfer.id} to ${transfer.destination}`);
          break;
        }

        case 'payout.paid': {
          const payout = event.data.object as Stripe.Payout;
          this.logger.log(`Payout completed: ${payout.id}`);
          break;
        }

        default:
          this.logger.log(`Unhandled Stripe event type: ${event.type}`);
      }

      return { success: true };
    } catch (error) {
      this.logger.error('Error processing Stripe webhook', error);
      return { success: false };
    }
  }

  async handleMercadoPagoWebhook(body: any, headers: any): Promise<{ success: boolean }> {
    // TODO: Implementar cuando se agregue MercadoPago
    this.logger.warn('MercadoPago webhook handling not implemented');
    return { success: true };
  }

  /* PayPal comentado temporalmente
  private async handleMerchantOnboardingCompleted(body: any): Promise<{ success: boolean }> {
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

  private async handleMerchantConsentRevoked(body: any): Promise<{ success: boolean }> {
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
  */
}
