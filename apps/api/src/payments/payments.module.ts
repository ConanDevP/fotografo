import { Module } from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { PaymentsController } from './payments.controller';
import { PrismaService } from '../common/services/prisma.service';
import { CloudinaryService } from '../common/services/cloudinary.service';
import { R2Service } from '../common/services/r2.service';
import { SharpTransformService } from '../common/services/sharp-transform.service';
import { StorageService } from '../common/services/storage.service';
import { QueueService } from '../common/services/queue.service';
import { PaymentGatewayFactory } from './factories/payment-gateway.factory';
import { PayPalGatewayService } from './gateways/paypal-gateway.service';

@Module({
  controllers: [PaymentsController],
  providers: [
    PaymentsService, 
    PrismaService, 
    CloudinaryService,
    R2Service,
    SharpTransformService,
    StorageService,
    QueueService,
    PaymentGatewayFactory,
    PayPalGatewayService,
  ],
  exports: [PaymentsService],
})
export class PaymentsModule {}