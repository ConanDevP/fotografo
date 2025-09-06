import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { QUEUES, JOBS } from '@shared/constants';
import { ProcessPhotoJob, SendBibEmailJob, ReprocessPhotoJob } from '@shared/types';

@Injectable()
export class QueueService implements OnModuleInit, OnModuleDestroy {
  private connection: IORedis;
  private processPhotoQueue: Queue<ProcessPhotoJob>;
  private sendEmailQueue: Queue<SendBibEmailJob>;
  private reprocessPhotoQueue: Queue<ReprocessPhotoJob>;

  constructor(private configService: ConfigService) {}

  onModuleInit() {
    // Try to use REDIS_URL first (Railway), fallback to individual host/port
    const redisUrl = this.configService.get('REDIS_URL');
    
    if (redisUrl) {
      this.connection = new IORedis(redisUrl, {
        maxRetriesPerRequest: 3,
      });
    } else {
      this.connection = new IORedis({
        host: this.configService.get('REDIS_HOST', 'localhost'),
        port: this.configService.get('REDIS_PORT', 6379),
        password: this.configService.get('REDIS_PASSWORD'),
        maxRetriesPerRequest: 3,
      });
    }

    this.processPhotoQueue = new Queue<ProcessPhotoJob>(QUEUES.PROCESS_PHOTO, {
      connection: this.connection,
      defaultJobOptions: {
        removeOnComplete: 100,
        removeOnFail: 50,
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 2000,
        },
      },
    });

    this.sendEmailQueue = new Queue<SendBibEmailJob>(QUEUES.SEND_BIB_EMAIL, {
      connection: this.connection,
      defaultJobOptions: {
        removeOnComplete: 200,
        removeOnFail: 100,
        attempts: 2,
        backoff: {
          type: 'exponential',
          delay: 1000,
        },
      },
    });

    this.reprocessPhotoQueue = new Queue<ReprocessPhotoJob>(QUEUES.REPROCESS_PHOTO, {
      connection: this.connection,
      defaultJobOptions: {
        removeOnComplete: 50,
        removeOnFail: 25,
        attempts: 2,
        backoff: {
          type: 'exponential',
          delay: 5000,
        },
      },
    });
  }

  async onModuleDestroy() {
    await Promise.all([
      this.processPhotoQueue?.close(),
      this.sendEmailQueue?.close(),
      this.reprocessPhotoQueue?.close(),
    ]);
    
    await this.connection?.disconnect();
  }

  async addProcessPhotoJob(job: ProcessPhotoJob, priority = 0) {
    return this.processPhotoQueue.add(JOBS.PROCESS_PHOTO, job, {
      priority,
      delay: 1000, // Small delay to ensure DB transaction is committed
    });
  }

  async addSendEmailJob(job: SendBibEmailJob, delay = 0) {
    return this.sendEmailQueue.add(JOBS.SEND_BIB_EMAIL, job, {
      delay,
    });
  }

  async addReprocessPhotoJob(job: ReprocessPhotoJob, priority = 10) {
    return this.reprocessPhotoQueue.add(JOBS.REPROCESS_PHOTO, job, {
      priority,
    });
  }

  // Queue monitoring methods
  async getProcessPhotoQueueStats() {
    return {
      waiting: await this.processPhotoQueue.getWaiting(),
      active: await this.processPhotoQueue.getActive(),
      completed: await this.processPhotoQueue.getCompleted(),
      failed: await this.processPhotoQueue.getFailed(),
    };
  }

  async getEmailQueueStats() {
    return {
      waiting: await this.sendEmailQueue.getWaiting(),
      active: await this.sendEmailQueue.getActive(), 
      completed: await this.sendEmailQueue.getCompleted(),
      failed: await this.sendEmailQueue.getFailed(),
    };
  }

  // Clean up queues
  async cleanQueues(grace = 5000) {
    await Promise.all([
      this.processPhotoQueue.clean(grace, 100),
      this.sendEmailQueue.clean(grace, 100),
      this.reprocessPhotoQueue.clean(grace, 50),
    ]);
  }
}