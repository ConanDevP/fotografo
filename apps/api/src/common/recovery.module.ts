import { Module } from '@nestjs/common';
import { JobRecoveryService } from './services/job-recovery.service';
import { PrismaService } from './services/prisma.service';
import { QueueService } from './services/queue.service';

@Module({
  providers: [JobRecoveryService, PrismaService, QueueService],
  exports: [JobRecoveryService],
})
export class RecoveryModule {}