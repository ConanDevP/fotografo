import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WebhooksService } from './webhooks.service';
import { WebhooksController } from './webhooks.controller';
import { PaymentsModule } from '../payments/payments.module';
import { PrismaService } from '../common/services/prisma.service';
import { StripeGatewayService } from '../payments/gateways/stripe-gateway.service';
import { StripeConnectService } from '../payments/gateways/stripe-connect.service';

// Factory providers para servicios opcionales de Stripe
const stripeGatewayProvider = {
  provide: StripeGatewayService,
  useFactory: (configService: ConfigService) => {
    const secretKey = configService.get('STRIPE_SECRET_KEY');
    if (!secretKey) {
      return null;
    }
    return new StripeGatewayService(configService);
  },
  inject: [ConfigService],
};

const stripeConnectProvider = {
  provide: StripeConnectService,
  useFactory: (configService: ConfigService, prisma: PrismaService) => {
    const secretKey = configService.get('STRIPE_SECRET_KEY');
    if (!secretKey) {
      return null;
    }
    return new StripeConnectService(configService, prisma);
  },
  inject: [ConfigService, PrismaService],
};

@Module({
  imports: [PaymentsModule],
  controllers: [WebhooksController],
  providers: [
    WebhooksService,
    PrismaService,
    stripeGatewayProvider,
    stripeConnectProvider,
  ],
  exports: [WebhooksService],
})
export class WebhooksModule { }