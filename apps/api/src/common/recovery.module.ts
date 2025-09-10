import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { JobRecoveryService } from './services/job-recovery.service';
import { PrismaService } from './services/prisma.service';
import { QueueService } from './services/queue.service';

@Module({
  imports: [ScheduleModule.forRoot()],
  providers: [JobRecoveryService, PrismaService, QueueService],
  exports: [JobRecoveryService],
})
export class RecoveryModule {}