import { Module } from '@nestjs/common';
import { JobRecoveryService } from './services/job-recovery.service';
import { PrismaService } from './services/prisma.service';
import { QueueService } from './services/queue.service';
import { StorageService } from './services/storage.service';
import { CloudinaryService } from './services/cloudinary.service';
import { R2Service } from './services/r2.service';
import { SharpTransformService } from './services/sharp-transform.service';

@Module({
  providers: [
    JobRecoveryService,
    PrismaService,
    QueueService,
    StorageService,
    CloudinaryService,
    R2Service,
    SharpTransformService,
  ],
  exports: [JobRecoveryService],
})
export class RecoveryModule {}