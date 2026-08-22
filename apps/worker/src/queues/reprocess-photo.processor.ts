import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';

import { PrismaService } from '../../../api/src/common/services/prisma.service';
import { OcrGeminiService } from '../services/ocr-gemini.service';
import { ImagesService } from '../services/images.service';
import { BatchProgressService } from '../services/batch-progress.service';
import { ReprocessPhotoJob } from '@shared/types';
import { QUEUES } from '@shared/constants';

@Processor(QUEUES.REPROCESS_PHOTO)
export class ReprocessPhotoProcessor extends WorkerHost {
  private readonly logger = new Logger(ReprocessPhotoProcessor.name);

  constructor(
    private prisma: PrismaService,
    private ocrService: OcrGeminiService,
    private imagesService: ImagesService,
    private batchProgress: BatchProgressService,
  ) {
    super();
  }

  async process(job: Job<ReprocessPhotoJob>): Promise<void> {
    const { photoId, strategy = 'default' } = job.data;
    const isFinalAttempt = job.attemptsMade + 1 >= Number(job.opts.attempts || 1);
    
    this.logger.log(`Reprocesando foto ${photoId} con estrategia ${strategy}`);

    try {
      // Get photo and event data
      const photo = await this.prisma.photo.findUnique({
        where: { id: photoId },
        include: { event: true },
      });

      if (!photo) {
        throw new Error(`Foto ${photoId} no encontrada`);
      }

      // Get optimized image for OCR
      const ocrImageUrl = await this.imagesService.getOptimizedImageForOCR(photo.cloudinaryId);

      // Perform OCR with specified strategy
      const geminiStrategy = strategy === 'pro' ? 'pro' : 'flash';
      const ocrResult = await this.ocrService.detectBibs(
        ocrImageUrl,
        photo.event.bibRules as any,
        geminiStrategy,
      );

      // Replace previous OCR results only after the new OCR call succeeds.
      await this.prisma.$transaction(async transaction => {
        await transaction.photoBib.deleteMany({ where: { photoId, source: 'GEMINI' } });
        if (ocrResult.bibs.length > 0) {
          await transaction.photoBib.createMany({
            data: ocrResult.bibs.map(bib => ({
              photoId,
              eventId: photo.eventId,
              bib: bib.value,
              confidence: bib.confidence,
              bbox: bib.bbox,
              source: 'GEMINI',
              promptTokens: ocrResult.usage?.promptTokens,
              candidatesTokens: ocrResult.usage?.candidatesTokens,
              totalTokens: ocrResult.usage?.totalTokens,
              geminiImageWidth: ocrResult.imageDimensions?.width,
              geminiImageHeight: ocrResult.imageDimensions?.height,
            })),
            skipDuplicates: true,
          });
        }
      });

      if (ocrResult.bibs.length > 0) {

        this.logger.log(`Reproceso completado: ${ocrResult.bibs.length} dorsales detectados`);
      } else {
        this.logger.warn(`Reproceso completado: no se detectaron dorsales`);
      }

      // Update photo status
      const processedAt = new Date();
      await this.prisma.photo.update({
        where: { id: photoId },
        data: { status: 'PROCESSED', ocrProcessedAt: processedAt, ocrFailedAt: null },
      });
      await this.prisma.batchUploadItem.updateMany({
        where: { photoId },
        data: { ocrProcessedAt: processedAt, ocrFailedAt: null, error: null },
      });
      await this.batchProgress.reconcileForPhoto(photoId);

      // Log the reprocess action
      await this.prisma.auditLog.create({
        data: {
          photoId,
          action: 'REPROCESS',
          data: {
            strategy,
            bibsDetected: ocrResult.bibs.length,
            bibs: ocrResult.bibs.map(b => b.value),
          },
        },
      });

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Error desconocido';
      const errorStack = error instanceof Error ? error.stack : undefined;
      this.logger.error(`Error reprocesando foto ${photoId}: ${errorMessage}`, errorStack);

      if (isFinalAttempt) {
        const failedAt = new Date();
        await Promise.all([
          this.prisma.photo.updateMany({ where: { id: photoId }, data: { ocrFailedAt: failedAt } }),
          this.prisma.batchUploadItem.updateMany({
            where: { photoId },
            data: { ocrFailedAt: failedAt, error: errorMessage.slice(0, 1000) },
          }),
        ]).catch(() => undefined);
        await this.batchProgress.reconcileForPhoto(photoId).catch(() => undefined);
      }

      throw error;
    }
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job<ReprocessPhotoJob>) {
    this.logger.log(`Reprocess job ${job.id} completado para foto ${job.data.photoId}`);
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<ReprocessPhotoJob>, err: Error) {
    this.logger.error(`Reprocess job ${job.id} falló para foto ${job.data.photoId}: ${err.message}`);
  }
}
