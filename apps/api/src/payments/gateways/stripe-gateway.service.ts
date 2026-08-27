import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { IPaymentGateway } from '../interfaces/payment-gateway.interface';
import {
    PaymentRequest,
    PaymentResponse,
    PaymentConfirmation,
    RefundResponse,
    PaymentStatus,
    PaymentGateway,
} from '@shared/payment-types';

@Injectable()
export class StripeGatewayService implements IPaymentGateway {
    private readonly logger = new Logger(StripeGatewayService.name);
    private readonly stripe: Stripe;
    private readonly webhookSecret: string;

    constructor(private configService: ConfigService) {
        const secretKey = this.configService.get('STRIPE_SECRET_KEY');
        this.webhookSecret = this.configService.get('STRIPE_WEBHOOK_SECRET', '');

        if (!secretKey) {
            this.logger.warn('Stripe no está configurado; los eventos gratuitos seguirán disponibles');
        }

        this.stripe = new Stripe(secretKey || 'sk_not_configured', {
            apiVersion: '2022-11-15',
        });

        if (secretKey) this.logger.log('Stripe Gateway configured');
    }

    /**
     * Create a payment using Stripe Checkout Session with Connect
     */
    async createPayment(request: PaymentRequest): Promise<PaymentResponse> {
        try {
            const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = request.items.map(item => ({
                price_data: {
                    currency: request.currency.toLowerCase(),
                    product_data: {
                        name: item.name,
                        description: item.description || undefined,
                    },
                    unit_amount: item.unitAmount, // Already in cents
                },
                quantity: item.quantity,
            }));

            // Build session params
            const sessionParams: Stripe.Checkout.SessionCreateParams = {
                mode: 'payment',
                line_items: lineItems,
                success_url: this.appendQuery(request.returnUrl, {
                    session_id: '{CHECKOUT_SESSION_ID}',
                    orderId: request.orderId,
                }),
                cancel_url: this.appendQuery(request.cancelUrl, { orderId: request.orderId }),
                metadata: {
                    orderId: request.orderId,
                    eventId: request.eventId,
                },
                payment_intent_data: {
                    transfer_group: request.transferGroup,
                    metadata: {
                        orderId: request.orderId,
                        eventId: request.eventId,
                    },
                },
            };

            // URL fragments are never sent to the web server, so the private
            // order token stays out of access logs and referrer headers.
            sessionParams.success_url = this.appendFragment(
                sessionParams.success_url,
                { token: request.downloadToken },
            );

            // If photographer has Stripe Connect account, use destination charges
            if (request.photographerStripeAccountId) {
                const platformFeeAmount = request.platformFeeAmount || 0;

                sessionParams.payment_intent_data = {
                    ...sessionParams.payment_intent_data,
                    application_fee_amount: platformFeeAmount,
                    transfer_data: {
                        destination: request.photographerStripeAccountId,
                    },
                };

                this.logger.log(`Creating Stripe session with Connect: destination=${request.photographerStripeAccountId}, fee=${platformFeeAmount}`);
            }

            // Managed Payments viene activo por defecto en la cuenta y es
            // incompatible con Connect: rechaza `transfer_group`, que es lo que
            // ata el cobro con las transferencias al fotógrafo. Se desactiva por
            // sesión en lugar de subir la versión de API, que cambiaría el
            // comportamiento de todos los cobros y disputas.
            (sessionParams as unknown as Record<string, unknown>).managed_payments = { enabled: false };

            const session = await this.stripe.checkout.sessions.create(sessionParams);

            this.logger.log(`Stripe Checkout Session created: ${session.id}`);

            return {
                paymentId: session.id,
                orderId: request.orderId,
                status: PaymentStatus.CREATED,
                gateway: PaymentGateway.STRIPE,
                redirectUrl: session.url || undefined,
                totalAmount: request.totalAmount,
                currency: request.currency,
                metadata: {
                    stripeSessionId: session.id,
                    stripeStatus: session.status,
                },
            };
        } catch (error) {
            this.logger.error('Error creating Stripe payment', error);
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            throw new BadRequestException('Error al crear pago con Stripe: ' + errorMessage);
        }
    }

    /**
     * Confirm payment after webhook or redirect
     */
    async confirmPayment(paymentId: string, details?: any): Promise<PaymentConfirmation> {
        try {
            // paymentId is the session_id
            const session = await this.stripe.checkout.sessions.retrieve(paymentId, {
                expand: ['payment_intent'],
            });

            let status: PaymentStatus;
            let transactionId: string | undefined;

            if (session.payment_status === 'paid') {
                status = PaymentStatus.APPROVED;
                const paymentIntent = session.payment_intent as Stripe.PaymentIntent;
                transactionId = paymentIntent?.id;
            } else if (session.payment_status === 'unpaid') {
                status = PaymentStatus.PENDING;
            } else {
                status = PaymentStatus.FAILED;
            }

            this.logger.log(`Stripe payment ${paymentId} confirmed with status: ${session.payment_status}`);

            return {
                paymentId,
                orderId: session.metadata?.orderId || '',
                status,
                transactionId,
                paidAmount: session.amount_total || 0,
                paidCurrency: session.currency?.toUpperCase(),
                gatewayResponse: session,
            };
        } catch (error) {
            this.logger.error(`Error confirming Stripe payment ${paymentId}`, error);
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            throw new BadRequestException('Error al confirmar pago con Stripe: ' + errorMessage);
        }
    }

    /**
     * Cancel/expire a checkout session
     */
    async cancelPayment(paymentId: string): Promise<void> {
        try {
            await this.stripe.checkout.sessions.expire(paymentId);
            this.logger.log(`Stripe session ${paymentId} expired`);
        } catch (error) {
            this.logger.error(`Error cancelling Stripe payment ${paymentId}`, error);
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            throw new BadRequestException('Error al cancelar pago con Stripe: ' + errorMessage);
        }
    }

    /**
     * Refund a payment
     */
    async refundPayment(paymentId: string, amount?: number): Promise<RefundResponse> {
        try {
            // Get the session to find the payment intent
            const session = await this.stripe.checkout.sessions.retrieve(paymentId, {
                expand: ['payment_intent'],
            });

            const paymentIntent = session.payment_intent as Stripe.PaymentIntent;
            if (!paymentIntent?.id) {
                throw new BadRequestException('No payment intent found for this session');
            }

            const refundParams: Stripe.RefundCreateParams = {
                payment_intent: paymentIntent.id,
            };

            if (amount) {
                refundParams.amount = amount;
            }

            const refund = await this.stripe.refunds.create(refundParams);

            this.logger.log(`Stripe refund created: ${refund.id} for payment ${paymentId}`);

            return {
                refundId: refund.id,
                paymentId,
                status: refund.status === 'succeeded' ? 'success' : 'pending',
                amount: refund.amount,
                currency: refund.currency.toUpperCase(),
            };
        } catch (error) {
            this.logger.error(`Error refunding Stripe payment ${paymentId}`, error);
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            throw new BadRequestException('Error al reembolsar pago con Stripe: ' + errorMessage);
        }
    }

    /**
     * Verify webhook signature
     */
    verifyWebhook(payload: any, signature: string): boolean {
        try {
            if (!this.webhookSecret) {
                this.logger.warn('Stripe webhook secret not configured');
                return false;
            }

            const event = this.stripe.webhooks.constructEvent(
                payload,
                signature,
                this.webhookSecret
            );

            return !!event;
        } catch (error) {
            this.logger.error('Stripe webhook verification failed', error);
            return false;
        }
    }

    /**
     * Parse and construct webhook event
     */
    constructWebhookEvent(payload: Buffer | string, signature: string): Stripe.Event {
        return this.stripe.webhooks.constructEvent(
            payload,
            signature,
            this.webhookSecret
        );
    }

    /**
     * Get Stripe instance for direct API calls
     */
    getStripeInstance(): Stripe {
        return this.stripe;
    }

    async getOpenCheckoutUrl(sessionId: string): Promise<string | undefined> {
        const session = await this.stripe.checkout.sessions.retrieve(sessionId);
        return session.status === 'open' ? session.url || undefined : undefined;
    }

    private appendQuery(url: string, values: Record<string, string | undefined>) {
        const query = Object.entries(values)
            .filter((entry): entry is [string, string] => Boolean(entry[1]))
            .map(([key, value]) => `${encodeURIComponent(key)}=${value === '{CHECKOUT_SESSION_ID}' ? value : encodeURIComponent(value)}`)
            .join('&');
        return `${url}${url.includes('?') ? '&' : '?'}${query}`;
    }

    private appendFragment(url: string, values: Record<string, string | undefined>) {
        const [base, currentFragment = ''] = url.split('#', 2);
        const fragment = new URLSearchParams(currentFragment);
        Object.entries(values).forEach(([key, value]) => {
            if (value) fragment.set(key, value);
        });
        const serialized = fragment.toString();
        return serialized ? `${base}#${serialized}` : base;
    }
}
