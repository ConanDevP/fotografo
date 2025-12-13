import { Injectable, BadRequestException, Optional } from '@nestjs/common';
import { PaymentGateway } from '@shared/payment-types';
import { IPaymentGateway } from '../interfaces/payment-gateway.interface';
// PayPal comentado temporalmente
// import { PayPalGatewayService } from '../gateways/paypal-gateway.service';
import { StripeGatewayService } from '../gateways/stripe-gateway.service';

@Injectable()
export class PaymentGatewayFactory {
  constructor(
    // @Optional() private readonly paypalGateway: PayPalGatewayService,
    @Optional() private readonly stripeGateway: StripeGatewayService,
    // private readonly mercadopagoGateway: MercadoPagoGatewayService, // TODO: Implementar
  ) { }

  createGateway(gateway: PaymentGateway): IPaymentGateway {
    switch (gateway) {
      /* PayPal comentado temporalmente
      case PaymentGateway.PAYPAL:
        if (!this.paypalGateway) {
          throw new BadRequestException('PayPal no está configurado');
        }
        return this.paypalGateway;
      */

      case PaymentGateway.STRIPE:
        if (!this.stripeGateway) {
          throw new BadRequestException('Stripe no está configurado');
        }
        return this.stripeGateway;

      // case PaymentGateway.MERCADOPAGO:
      //   return this.mercadopagoGateway;

      case PaymentGateway.DEMO:
        // Demo gateway implementado en PaymentsService
        throw new BadRequestException('Demo gateway no maneja pagos reales');

      default:
        throw new BadRequestException(`Gateway de pago no soportado: ${gateway}`);
    }
  }

  getSupportedGateways(): PaymentGateway[] {
    const gateways: PaymentGateway[] = [PaymentGateway.DEMO];

    /* PayPal comentado temporalmente
    if (this.paypalGateway) {
      gateways.push(PaymentGateway.PAYPAL);
    }
    */

    if (this.stripeGateway) {
      gateways.push(PaymentGateway.STRIPE);
    }

    return gateways;
  }
}