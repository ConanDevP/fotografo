import { Module } from '@nestjs/common';

import { ChannelsController } from './channels.controller';
import { ChannelsService } from './channels.service';
import { ChannelHealthService } from './channel-health.service';
import { TemplateSyncService } from './template-sync.service';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { PrismaService } from '../common/services/prisma.service';
import { QueueService } from '../common/services/queue.service';
import { MailerService } from '../common/services/mailer.service';
import { DigestSchedulerService } from '../common/services/digest-scheduler.service';

@Module({
  imports: [WorkspacesModule],
  controllers: [ChannelsController],
  providers: [ChannelsService, ChannelHealthService, TemplateSyncService, PrismaService, QueueService, MailerService, DigestSchedulerService],
  exports: [ChannelHealthService],
})
export class MessagingModule {}
