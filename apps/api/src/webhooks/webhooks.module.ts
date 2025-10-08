import { Module } from '@nestjs/common';
import { WebhooksService } from './webhooks.service';
import { WebhooksController } from './webhooks.controller';
import { PaymentsModule } from '../payments/payments.module';
import { PrismaService } from '../common/services/prisma.service';

@Module({
  imports: [PaymentsModule],
  controllers: [WebhooksController],
  providers: [WebhooksService, PrismaService],
  exports: [WebhooksService],
})
export class WebhooksModule {}