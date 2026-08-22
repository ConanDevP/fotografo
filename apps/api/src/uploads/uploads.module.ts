import { Module } from '@nestjs/common';
import { UploadsService } from './uploads.service';
import { UploadsController } from './uploads.controller';
import { ProgressStreamController } from './progress-stream.controller';
import { CloudinaryService } from '../common/services/cloudinary.service';
import { R2Service } from '../common/services/r2.service';
import { SharpTransformService } from '../common/services/sharp-transform.service';
import { StorageService } from '../common/services/storage.service';
import { PrismaService } from '../common/services/prisma.service';
import { QueueService } from '../common/services/queue.service';
import { EventsModule } from '../events/events.module';
import { RecoveryModule } from '../common/recovery.module';
import { BillingModule } from '../billing/billing.module';

@Module({
  imports: [EventsModule, RecoveryModule, BillingModule],
  controllers: [UploadsController, ProgressStreamController],
  providers: [
    UploadsService, 
    CloudinaryService, 
    R2Service, 
    SharpTransformService, 
    StorageService, 
    PrismaService, 
    QueueService,
  ],
  exports: [UploadsService],
})
export class UploadsModule {}
