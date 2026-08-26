import { forwardRef, Module } from '@nestjs/common';
import { PrismaService } from '../common/services/prisma.service';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { PlanSubscriptionsService } from './plan-subscriptions.service';
import { ShareBillingService } from './share-billing.service';

@Module({
  imports: [forwardRef(() => WorkspacesModule)],
  controllers: [BillingController],
  providers: [BillingService, PlanSubscriptionsService, ShareBillingService, PrismaService],
  exports: [BillingService, PlanSubscriptionsService, ShareBillingService],
})
export class BillingModule {}
