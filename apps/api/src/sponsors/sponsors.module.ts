import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module';
import { PrismaService } from '../common/services/prisma.service';
import { EventsModule } from '../events/events.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { SponsorsController } from './sponsors.controller';
import { SponsorsService } from './sponsors.service';

@Module({
  imports: [EventsModule, WorkspacesModule, BillingModule],
  controllers: [SponsorsController],
  providers: [SponsorsService, PrismaService],
  exports: [SponsorsService],
})
export class SponsorsModule {}

