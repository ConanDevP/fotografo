import { Module } from '@nestjs/common';
import { UploadsService } from './uploads.service';
import { UploadsController } from './uploads.controller';
import { CloudinaryService } from '../common/services/cloudinary.service';
import { R2Service } from '../common/services/r2.service';
import { SharpTransformService } from '../common/services/sharp-transform.service';
import { StorageService } from '../common/services/storage.service';
import { PrismaService } from '../common/services/prisma.service';
import { QueueService } from '../common/services/queue.service';
import { JobRecoveryService } from '../common/services/job-recovery.service';

@Module({
  controllers: [UploadsController],
  providers: [
    UploadsService, 
    CloudinaryService, 
    R2Service, 
    SharpTransformService, 
    StorageService, 
    PrismaService, 
    QueueService,
    JobRecoveryService,
  ],
  exports: [UploadsService],
})
export class UploadsModule {}