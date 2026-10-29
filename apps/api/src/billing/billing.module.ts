import { forwardRef, Module } from '@nestjs/common';
import { PrismaService } from '../common/services/prisma.service';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { PlanSubscriptionsService } from './plan-subscriptions.service';
import { ShareBillingService } from './share-billing.service';
import { MeteringService } from './metering.service';
import { ProcessingPriorityService } from './processing-priority.service';

@Module({
  imports: [forwardRef(() => WorkspacesModule)],
  controllers: [BillingController],
  providers: [BillingService, PlanSubscriptionsService, ShareBillingService, MeteringService, ProcessingPriorityService, PrismaService],
  exports: [BillingService, PlanSubscriptionsService, ShareBillingService, MeteringService, ProcessingPriorityService],
})
export class BillingModule {}
