import { Module } from '@nestjs/common';
import { PrismaService } from '../common/services/prisma.service';
import { EventsModule } from '../events/events.module';
import { UploadsModule } from '../uploads/uploads.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { ApiClientsController } from './api-clients.controller';
import { ApiClientsService } from './api-clients.service';
import { PartnerApiController } from './partner-api.controller';
import { PartnerApiKeyGuard } from './partner-api-key.guard';
import { PartnerApiService } from './partner-api.service';
import { PhotosModule } from '../photos/photos.module';
import { SearchModule } from '../search/search.module';
import { PartnerWebhooksService } from './partner-webhooks.service';
import { WorkspaceWebhooksController } from './workspace-webhooks.controller';
import { SponsorsModule } from '../sponsors/sponsors.module';
import { MetricsModule } from '../metrics/metrics.module';

@Module({
  imports: [WorkspacesModule, EventsModule, UploadsModule, PhotosModule, SearchModule, SponsorsModule, MetricsModule],
  controllers: [ApiClientsController, PartnerApiController, WorkspaceWebhooksController],
  providers: [PrismaService, ApiClientsService, PartnerApiKeyGuard, PartnerApiService, PartnerWebhooksService],
  exports: [PartnerWebhooksService],
})
export class PartnerApiModule {}
