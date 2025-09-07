import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as paypal from '@paypal/checkout-server-sdk';
import { IPaymentGateway } from '../interfaces/payment-gateway.interface';
import {
  PaymentRequest,
  PaymentResponse,
  PaymentConfirmation,
  RefundResponse,
  PaymentStatus,
  PaymentGateway,
  PayPalOrderResponse,
} from '@shared/payment-types';

@Injectable()
export class PayPalGatewayService implements IPaymentGateway {
  private readonly logger = new Logger(PayPalGatewayService.name);
  private readonly client: paypal.core.PayPalHttpClient;

  constructor(private configService: ConfigService) {
    const clientId = this.configService.get('PAYPAL_CLIENT_ID');
    const clientSecret = this.configService.get('PAYPAL_CLIENT_SECRET');
    const mode = this.configService.get('PAYPAL_MODE', 'sandbox');

    if (!clientId || !clientSecret) {
      throw new Error('PayPal credentials not configured');
    }

    // Configurar entorno PayPal
    const environment = mode === 'production' 
      ? new paypal.core.LiveEnvironment(clientId, clientSecret)
      : new paypal.core.SandboxEnvironment(clientId, clientSecret);

    this.client = new paypal.core.PayPalHttpClient(environment);
    this.logger.log(`PayPal configured in ${mode} mode`);
  }

  async createPayment(request: PaymentRequest): Promise<PaymentResponse> {
    try {
      const paypalRequest = new paypal.orders.OrdersCreateRequest();
      
      // Configurar orden PayPal
      paypalRequest.requestBody({
        intent: 'CAPTURE',
        application_context: {
          brand_name: 'Fotografos Platform',
          landing_page: 'NO_PREFERENCE',
          shipping_preference: 'NO_SHIPPING',
          user_action: 'PAY_NOW',
          return_url: request.returnUrl,
          cancel_url: request.cancelUrl,
        },
        purchase_units: [
          {
            reference_id: request.orderId,
            description: request.description || 'Compra de fotos',
            amount: {
              currency_code: request.currency.toUpperCase(),
              value: (request.totalAmount / 100).toFixed(2), // Convertir de centavos
              breakdown: {
                item_total: {
                  currency_code: request.currency.toUpperCase(),
                  value: (request.totalAmount / 100).toFixed(2),
                },
              },
            },
            items: request.items.map(item => ({
              name: item.name,
              description: item.description || '',
              quantity: item.quantity.toString(),
              unit_amount: {
                currency_code: request.currency.toUpperCase(),
                value: (item.unitAmount / 100).toFixed(2),
              },
            })),
          },
        ],
      });

      // Ejecutar request a PayPal
      const response = await this.client.execute(paypalRequest);
      const order = response.result as PayPalOrderResponse;

      // Encontrar URL de aprobación
      const approvalUrl = order.links?.find(link => link.rel === 'approve')?.href;

      if (!approvalUrl) {
        throw new BadRequestException('No se pudo generar URL de pago PayPal');
      }

      this.logger.log(`PayPal order created: ${order.id}`);

      return {
        paymentId: order.id,
        orderId: request.orderId,
        status: PaymentStatus.CREATED,
        gateway: PaymentGateway.PAYPAL,
        redirectUrl: approvalUrl,
        totalAmount: request.totalAmount,
        currency: request.currency,
        metadata: {
          paypalOrderId: order.id,
          paypalStatus: order.status,
        },
      };
    } catch (error) {
      this.logger.error('Error creating PayPal payment', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new BadRequestException('Error al crear pago PayPal: ' + errorMessage);
    }
  }

  async confirmPayment(paymentId: string, details?: any): Promise<PaymentConfirmation> {
    try {
      const request = new paypal.orders.OrdersCaptureRequest(paymentId);
      const response = await this.client.execute(request);
      const order = response.result;

      const captureStatus = order.purchase_units[0]?.payments?.captures?.[0]?.status;
      const transactionId = order.purchase_units[0]?.payments?.captures?.[0]?.id;
      
      let status: PaymentStatus;
      switch (captureStatus) {
        case 'COMPLETED':
          status = PaymentStatus.APPROVED;
          break;
        case 'PENDING':
          status = PaymentStatus.PENDING;
          break;
        default:
          status = PaymentStatus.FAILED;
      }

      this.logger.log(`PayPal payment ${paymentId} confirmed with status: ${captureStatus}`);

      return {
        paymentId,
        orderId: order.purchase_units[0]?.reference_id || '',
        status,
        transactionId,
        paidAmount: Math.round(parseFloat(order.purchase_units[0]?.amount?.value || '0') * 100),
        paidCurrency: order.purchase_units[0]?.amount?.currency_code,
        gatewayResponse: order,
      };
    } catch (error) {
      this.logger.error(`Error confirming PayPal payment ${paymentId}`, error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new BadRequestException('Error al confirmar pago PayPal: ' + errorMessage);
    }
  }

  async cancelPayment(paymentId: string): Promise<void> {
    try {
      // PayPal orders se cancelan automáticamente si no se capturan
      this.logger.log(`PayPal payment ${paymentId} marked as cancelled`);
    } catch (error) {
      this.logger.error(`Error cancelling PayPal payment ${paymentId}`, error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new BadRequestException('Error al cancelar pago PayPal: ' + errorMessage);
    }
  }

  async refundPayment(paymentId: string, amount?: number): Promise<RefundResponse> {
    try {
      // Primero obtener la captura original
      const orderRequest = new paypal.orders.OrdersGetRequest(paymentId);
      const orderResponse = await this.client.execute(orderRequest);
      const order = orderResponse.result;

      const captureId = order.purchase_units[0]?.payments?.captures?.[0]?.id;
      if (!captureId) {
        throw new BadRequestException('No se encontró captura para reembolsar');
      }

      // Crear reembolso
      const refundRequest = new paypal.payments.CapturesRefundRequest(captureId);
      
      if (amount) {
        refundRequest.requestBody({
          amount: {
            currency_code: order.purchase_units[0].amount.currency_code,
            value: (amount / 100).toFixed(2),
          },
        });
      }

      const refundResponse = await this.client.execute(refundRequest);
      const refund = refundResponse.result;

      this.logger.log(`PayPal refund created: ${refund.id} for payment ${paymentId}`);

      return {
        refundId: refund.id,
        paymentId,
        status: refund.status === 'COMPLETED' ? 'success' : 'pending',
        amount: Math.round(parseFloat(refund.amount.value) * 100),
        currency: refund.amount.currency_code,
      };
    } catch (error) {
      this.logger.error(`Error refunding PayPal payment ${paymentId}`, error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new BadRequestException('Error al reembolsar pago PayPal: ' + errorMessage);
    }
  }

  verifyWebhook(payload: any, signature: string): boolean {
    // TODO: Implementar verificación de webhook PayPal
    // PayPal usa un sistema diferente de verificación
    this.logger.warn('PayPal webhook verification not implemented yet');
    return true; // Por ahora acepta todos los webhooks
  }

  private formatCurrency(amount: number): string {
    return (amount / 100).toFixed(2);
  }
}