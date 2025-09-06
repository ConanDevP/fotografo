import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';

import { PrismaService } from '../../../api/src/common/services/prisma.service';
import { OcrGeminiService } from '../services/ocr-gemini.service';
import { ImagesService } from '../services/images.service';
import { ReprocessPhotoJob } from '@shared/types';
import { QUEUES } from '@shared/constants';

@Processor(QUEUES.REPROCESS_PHOTO)
export class ReprocessPhotoProcessor extends WorkerHost {
  private readonly logger = new Logger(ReprocessPhotoProcessor.name);

  constructor(
    private prisma: PrismaService,
    private ocrService: OcrGeminiService,
    private imagesService: ImagesService,
  ) {
    super();
  }

  async process(job: Job<ReprocessPhotoJob>): Promise<void> {
    const { photoId, strategy = 'default' } = job.data;
    
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

      // Clear existing GEMINI bibs
      await this.prisma.photoBib.deleteMany({
        where: {
          photoId,
          source: 'GEMINI',
        },
      });

      // Get optimized image for OCR
      const ocrImageUrl = await this.imagesService.getOptimizedImageForOCR(photo.cloudinaryId);

      // Perform OCR with specified strategy
      const geminiStrategy = strategy === 'pro' ? 'pro' : 'flash';
      const ocrResult = await this.ocrService.detectBibs(
        ocrImageUrl,
        photo.event.bibRules as any,
        geminiStrategy,
      );

      // Save new detected bibs
      if (ocrResult.bibs.length > 0) {
        await this.prisma.photoBib.createMany({
          data: ocrResult.bibs.map(bib => ({
            photoId,
            eventId: photo.eventId,
            bib: bib.value,
            confidence: bib.confidence,
            bbox: bib.bbox,
            source: 'GEMINI',
          })),
        });

        this.logger.log(`Reproceso completado: ${ocrResult.bibs.length} dorsales detectados`);
      } else {
        this.logger.warn(`Reproceso completado: no se detectaron dorsales`);
      }

      // Update photo status
      await this.prisma.photo.update({
        where: { id: photoId },
        data: { status: 'PROCESSED' },
      });

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

      // Mark photo as failed
      await this.prisma.photo.update({
        where: { id: photoId },
        data: { status: 'FAILED' },
      }).catch(() => {
        // Ignore DB errors during error handling
      });

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