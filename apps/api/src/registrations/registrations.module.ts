import { Module } from '@nestjs/common';

import { RegistrationsService } from './registrations.service';
import { RegistrationsPublicController } from './registrations-public.controller';
import { RegistrationsAdminController } from './registrations-admin.controller';
import { RegistrationRetentionService } from './registration-retention.service';
import { EventsModule } from '../events/events.module';
import { PartnerApiModule } from '../partner-api/partner-api.module';
import { PrismaService } from '../common/services/prisma.service';
import { QueueService } from '../common/services/queue.service';
import { DigestSchedulerService } from '../common/services/digest-scheduler.service';

@Module({
  imports: [EventsModule, PartnerApiModule],
  controllers: [RegistrationsPublicController, RegistrationsAdminController],
  providers: [RegistrationsService, RegistrationRetentionService, PrismaService, QueueService, DigestSchedulerService],
  exports: [RegistrationsService],
})
export class RegistrationsModule {}
