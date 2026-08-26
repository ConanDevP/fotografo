import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module';
import { ConfigModule } from '@nestjs/config';
import { PrismaService } from '../common/services/prisma.service';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';

@Module({
  imports: [ConfigModule, WorkspacesModule, BillingModule],
  controllers: [MetricsController],
  providers: [MetricsService, PrismaService],
  exports: [MetricsService],
})
export class MetricsModule {}

