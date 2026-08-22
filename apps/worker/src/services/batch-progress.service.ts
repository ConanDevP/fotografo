import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

import { PrismaService } from '../../../api/src/common/services/prisma.service';
import { InferBibsJob } from '@shared/types';
import { JOBS, QUEUES } from '@shared/constants';

@Injectable()
export class BatchProgressService {
  private readonly logger = new Logger(BatchProgressService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(QUEUES.INFER_BIBS) private readonly inferQueue: Queue<InferBibsJob>,
  ) {}

  async reconcileForPhoto(photoId: string): Promise<void> {
    const item = await this.prisma.batchUploadItem.findFirst({
      where: { photoId },
      select: { batchJobId: true },
    });

    if (item) {
      await this.reconcile(item.batchJobId);
      return;
    }

    const photo = await this.prisma.photo.findUnique({
      where: { id: photoId },
      select: { batchJobId: true },
    });
    if (photo?.batchJobId) {
      await this.reconcile(photo.batchJobId);
    }
  }

  async reconcile(batchJobId: string): Promise<void> {
    const job = await this.prisma.batchUploadJob.findUnique({
      where: { id: batchJobId },
      select: { totalFiles: true, status: true, eventId: true },
    });
    if (!job) return;

    const [
      itemCount,
      uploadedFiles,
      processedFiles,
      failedItems,
      watermarkFiles,
      failedWatermarks,
      geminiFiles,
      failedGemini,
      faceFiles,
      failedFaces,
    ] = await Promise.all([
      this.prisma.batchUploadItem.count({ where: { batchJobId } }),
      this.prisma.batchUploadItem.count({ where: { batchJobId, photoId: { not: null } } }),
      this.prisma.batchUploadItem.count({
        where: { batchJobId, status: { in: ['COMPLETED', 'DUPLICATE', 'FAILED'] } },
      }),
      this.prisma.batchUploadItem.count({ where: { batchJobId, status: 'FAILED' } }),
      this.prisma.batchUploadItem.count({ where: { batchJobId, derivativesProcessedAt: { not: null } } }),
      this.prisma.batchUploadItem.count({
        where: { batchJobId, derivativesProcessedAt: null, watermarkFailedAt: { not: null } },
      }),
      this.prisma.batchUploadItem.count({ where: { batchJobId, ocrProcessedAt: { not: null } } }),
      this.prisma.batchUploadItem.count({
        where: { batchJobId, ocrProcessedAt: null, ocrFailedAt: { not: null } },
      }),
      this.prisma.batchUploadItem.count({ where: { batchJobId, faceProcessedAt: { not: null } } }),
      this.prisma.batchUploadItem.count({
        where: { batchJobId, faceProcessedAt: null, faceFailedAt: { not: null } },
      }),
    ]);

    let status = job.status;
    if (itemCount > 0) {
      if (itemCount < job.totalFiles) {
        status = 'UPLOADING';
      } else if (processedFiles >= job.totalFiles) {
        status = failedItems > 0 ? 'FAILED' : 'COMPLETED';
      } else {
        status = 'PROCESSING';
      }
    }

    const wasRunning = job.status !== 'COMPLETED' && job.status !== 'FAILED';

    await this.prisma.batchUploadJob.update({
      where: { id: batchJobId },
      data: {
        status,
        uploadedFiles,
        processedFiles,
        watermarkFiles,
        failedWatermarks,
        geminiFiles,
        failedGemini,
        faceFiles,
        failedFaces,
        updatedAt: new Date(),
      },
    });

    // Al cerrar el lote ya están todas las fotografías del evento, incluida la
    // que enseña rostro y dorsal juntos. Es el momento de repasar las caras que
    // se quedaron sin número porque su puente aún no existía.
    if (wasRunning && (status === 'COMPLETED' || status === 'FAILED')) {
      await this.enqueueEventSweep(job.eventId, batchJobId);
    }
  }

  private async enqueueEventSweep(eventId: string, batchJobId: string) {
    try {
      await this.inferQueue.add(
        JOBS.INFER_BIBS,
        { eventId, sweep: true },
        {
          // El identificador incluye el lote para que cada subida provoque su
          // propio repaso: con un id fijo, BullMQ descartaría el segundo.
          jobId: `sweep-${eventId}-${batchJobId}`,
          delay: 30_000,
          attempts: 2,
          backoff: { type: 'exponential', delay: 30_000 },
          removeOnComplete: 50,
          removeOnFail: 20,
        },
      );
      this.logger.log(`🧹 Repaso de inferencia encolado para el evento ${eventId}`);
    } catch (error) {
      this.logger.warn(
        `No se pudo encolar el repaso del evento ${eventId}: ${
          error instanceof Error ? error.message : 'error desconocido'
        }`,
      );
    }
  }
}

