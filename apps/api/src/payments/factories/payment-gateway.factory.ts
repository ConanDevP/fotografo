import { Injectable, BadRequestException } from '@nestjs/common';
import { PaymentGateway } from '@shared/payment-types';
import { IPaymentGateway } from '../interfaces/payment-gateway.interface';
import { PayPalGatewayService } from '../gateways/paypal-gateway.service';

@Injectable()
export class PaymentGatewayFactory {
  constructor(
    private readonly paypalGateway: PayPalGatewayService,
    // private readonly stripeGateway: StripeGatewayService, // TODO: Implementar
    // private readonly mercadopagoGateway: MercadoPagoGatewayService, // TODO: Implementar
  ) {}

  createGateway(gateway: PaymentGateway): IPaymentGateway {
    switch (gateway) {
      case PaymentGateway.PAYPAL:
        return this.paypalGateway;
      
      // case PaymentGateway.STRIPE:
      //   return this.stripeGateway;
      
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
    return [
      PaymentGateway.PAYPAL,
      PaymentGateway.DEMO,
      // PaymentGateway.STRIPE, // TODO: Habilitar cuando esté implementado
      // PaymentGateway.MERCADOPAGO, // TODO: Habilitar cuando esté implementado
    ];
  }
}