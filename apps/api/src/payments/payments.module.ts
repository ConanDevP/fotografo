import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PaymentsService } from './payments.service';
import { PaymentsController } from './payments.controller';
import { PrismaService } from '../common/services/prisma.service';
import { CloudinaryService } from '../common/services/cloudinary.service';
import { R2Service } from '../common/services/r2.service';
import { SharpTransformService } from '../common/services/sharp-transform.service';
import { StorageService } from '../common/services/storage.service';
import { QueueService } from '../common/services/queue.service';
import { PaymentGatewayFactory } from './factories/payment-gateway.factory';
import { BillingModule } from '../billing/billing.module';
// PayPal comentado temporalmente
// import { PayPalGatewayService } from './gateways/paypal-gateway.service';
// import { PayPalPartnerService } from './gateways/paypal-partner.service';
import { StripeGatewayService } from './gateways/stripe-gateway.service';
import { StripeConnectService } from './gateways/stripe-connect.service';
// import { PayPalOnboardingController } from '../photographers/paypal-onboarding.controller';
import { StripeOnboardingController } from '../photographers/stripe-onboarding.controller';

// Factory providers para servicios opcionales
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

/* PayPal comentado temporalmente
const paypalGatewayProvider = {
  provide: PayPalGatewayService,
  useFactory: (configService: ConfigService) => {
    const clientId = configService.get('PAYPAL_CLIENT_ID');
    const clientSecret = configService.get('PAYPAL_CLIENT_SECRET');
    if (!clientId || !clientSecret) {
      return null;
    }
    return new PayPalGatewayService(configService);
  },
  inject: [ConfigService],
};

const paypalPartnerProvider = {
  provide: PayPalPartnerService,
  useFactory: (configService: ConfigService) => {
    const clientId = configService.get('PAYPAL_CLIENT_ID');
    const clientSecret = configService.get('PAYPAL_CLIENT_SECRET');
    if (!clientId || !clientSecret) {
      return null;
    }
    return new PayPalPartnerService(configService);
  },
  inject: [ConfigService],
};
*/

@Module({
  imports: [BillingModule],
  controllers: [PaymentsController, StripeOnboardingController],
  providers: [
    PaymentsService,
    PrismaService,
    CloudinaryService,
    R2Service,
    SharpTransformService,
    StorageService,
    QueueService,
    PaymentGatewayFactory,
    // paypalGatewayProvider,
    // paypalPartnerProvider,
    stripeGatewayProvider,
    stripeConnectProvider,
  ],
  exports: [PaymentsService, StripeConnectService],
})
export class PaymentsModule { }