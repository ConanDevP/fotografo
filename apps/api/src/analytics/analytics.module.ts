import { forwardRef, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaService } from '../common/services/prisma.service';
import { MailerService } from '../common/services/mailer.service';
import { EventsModule } from '../events/events.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { BillingModule } from '../billing/billing.module';
import { PartnerApiModule } from '../partner-api/partner-api.module';
import { AnalyticsController } from './analytics.controller';
import { ReportController } from './report.controller';
import { AnalyticsService } from './analytics.service';
import { AnalyticsRollupService } from './analytics-rollup.service';
import { SponsorAnalyticsService } from './sponsor-analytics.service';
import { PostEventReportService } from './post-event-report.service';

@Module({
  imports: [
    ConfigModule,
    EventsModule,
    WorkspacesModule,
    BillingModule,
    forwardRef(() => PartnerApiModule),
  ],
  controllers: [AnalyticsController, ReportController],
  providers: [
    AnalyticsService,
    AnalyticsRollupService,
    SponsorAnalyticsService,
    PostEventReportService,
    MailerService,
    PrismaService,
  ],
  exports: [AnalyticsService, AnalyticsRollupService],
})
export class AnalyticsModule {}
