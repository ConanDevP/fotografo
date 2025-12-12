import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../../../api/src/common/services/prisma.service';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { QUEUES } from '@shared/constants';

@Injectable()
export class RescueJobsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RescueJobsService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private prisma: PrismaService,
    @InjectQueue(QUEUES.PROCESS_FACE) private faceQueue: Queue,
    @InjectQueue(QUEUES.INFER_BIBS) private inferQueue: Queue,
  ) {}

  onModuleInit() {
    // Run every 60s
    this.timer = setInterval(() => this.runRescue().catch(() => {}), 60_000);
    // Also run shortly after boot
    setTimeout(() => this.runRescue().catch(() => {}), 10_000);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async runRescue() {
    const since = new Date(Date.now() - 2 * 60 * 60 * 1000); // last 2h
    await Promise.all([
      this.rescueMissingFaces(since),
      this.rescueMissingInferences(since),
    ]);
  }

  private async rescueMissingFaces(since: Date) {
    try {
      const photos = await this.prisma.photo.findMany({
        where: {
          status: 'PROCESSED',
          createdAt: { gte: since },
          faces: { none: {} },
        },
        select: { id: true, eventId: true, originalUrl: true },
        take: 50,
      });

      for (const p of photos) {
        // Remove stuck job if exists
        try {
          const existingJob = await this.faceQueue.getJob(`face-${p.id}`);
          if (existingJob) {
            const state = await existingJob.getState();
            if (state === 'waiting' || state === 'delayed') {
              await existingJob.remove();
            }
          }
        } catch (e) {
          // Ignore
        }

        await this.faceQueue.add(
          'process-face',
          { photoId: p.id, eventId: p.eventId, imageUrl: p.originalUrl },
          { attempts: 3, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: 10, removeOnFail: 5 }
        );
        this.logger.log(`🛟 Rescue enqueued face processing for photo ${p.id}`);
      }
    } catch (e) {
      // ignore
    }
  }

  private async rescueMissingInferences(since: Date) {
    try {
      const photos = await this.prisma.photo.findMany({
        where: {
          status: 'PROCESSED',
          createdAt: { gte: since },
          faces: { some: {} },
        },
        select: { id: true, eventId: true },
        take: 50,
      });

      for (const p of photos) {
        await this.inferQueue.add(
          'infer-bibs',
          { photoId: p.id, eventId: p.eventId },
          { jobId: `infer-${p.id}`, attempts: 3, backoff: { type: 'exponential', delay: 10_000 }, removeOnComplete: 10, removeOnFail: 5 }
        );
        this.logger.log(`🛟 Rescue enqueued inference for photo ${p.id}`);
      }
    } catch (e) {
      // ignore
    }
  }
}

