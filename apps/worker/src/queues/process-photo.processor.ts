import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';

import { PrismaService } from '../../../api/src/common/services/prisma.service';
import { OcrGeminiService } from '../services/ocr-gemini.service';
import { ImagesService } from '../services/images.service';
import { CloudinaryService } from '../../../api/src/common/services/cloudinary.service';
import { ProcessPhotoJob } from '@shared/types';
import { QUEUES } from '@shared/constants';

@Processor(QUEUES.PROCESS_PHOTO)
export class ProcessPhotoProcessor extends WorkerHost {
  private readonly logger = new Logger(ProcessPhotoProcessor.name);

  constructor(
    private prisma: PrismaService,
    private ocrService: OcrGeminiService,
    private imagesService: ImagesService,
    private cloudinaryService: CloudinaryService,
  ) {
    super();
  }

  async process(job: Job<ProcessPhotoJob>): Promise<void> {
    const { photoId, eventId, objectKey } = job.data;
    
    this.logger.log(`Procesando foto ${photoId} para evento ${eventId}`);

    try {
      // Get photo and event data
      const [photo, event] = await Promise.all([
        this.prisma.photo.findUnique({ where: { id: photoId } }),
        this.prisma.event.findUnique({ where: { id: eventId } }),
      ]);

      if (!photo || !event) {
        throw new Error('Foto o evento no encontrado');
      }

      // Step 1: Generate image derivatives (thumbnail, watermark)
      job.updateProgress(25);
      const derivatives = await this.imagesService.generateDerivatives(
        objectKey, 
        eventId, 
        photoId
      );

      // Update photo with derivative URLs
      await this.prisma.photo.update({
        where: { id: photoId },
        data: {
          thumbUrl: derivatives.thumbUrl,
          watermarkUrl: derivatives.watermarkUrl,
        },
      });

      // Step 2: Get optimized image for OCR
      job.updateProgress(40);
      const ocrImageUrl = await this.imagesService.getOptimizedImageForOCR(objectKey);

      // Step 3: Perform OCR with Gemini
      job.updateProgress(60);
      const ocrResult = await this.ocrService.detectBibs(
        ocrImageUrl,
        event.bibRules as any,
        'flash' // Use flash model by default
      );

      // Step 4: Save detected bibs to database
      job.updateProgress(70);
      if (ocrResult.bibs.length > 0) {
        await this.prisma.photoBib.createMany({
          data: ocrResult.bibs.map(bib => ({
            photoId,
            eventId,
            bib: bib.value,
            confidence: bib.confidence,
            bbox: bib.bbox,
            source: 'GEMINI',
            promptTokens: ocrResult.usage?.promptTokens,
            candidatesTokens: ocrResult.usage?.candidatesTokens,
            totalTokens: ocrResult.usage?.totalTokens,
          })),
          skipDuplicates: true,
        });

        this.logger.log(`Guardados ${ocrResult.bibs.length} dorsales para foto ${photoId}`);

        // Step 5: Organize photos by bibs in Cloudinary folders (DISABLED for now)
        job.updateProgress(80);
        // TODO: Fix copyToFolder method in CloudinaryService
        // await this.organizePhotoByBibs(objectKey, eventId, photoId, ocrResult.bibs.map(b => b.value));
        this.logger.log(`Skipping bib organization for now - photos are already accessible via search`);

        // Step 6: Check for subscriptions and send notifications
        const uniqueBibs = [...new Set(ocrResult.bibs.map(b => b.value))];
        const subscriptions = await this.prisma.bibSubscription.findMany({
          where: {
            eventId,
            bib: { in: uniqueBibs },
          },
        });

        // Enqueue email notifications for subscribers
        for (const subscription of subscriptions) {
          // Note: In a real implementation, you'd inject QueueService or emit events
          // For now, we'll skip the email queue to avoid circular dependencies
          this.logger.log(`Dorsal ${subscription.bib} tiene suscripción para ${subscription.email}`);
        }
      }

      // Step 7: Mark photo as processed
      job.updateProgress(100);
      await this.prisma.photo.update({
        where: { id: photoId },
        data: { status: 'PROCESSED' },
      });

      this.logger.log(`Foto ${photoId} procesada exitosamente`);

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Error desconocido';
      const errorStack = error instanceof Error ? error.stack : undefined;
      this.logger.error(`Error procesando foto ${photoId}: ${errorMessage}`, errorStack);

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

  private async organizePhotoByBibs(
    sourceCloudinaryId: string,
    eventId: string,
    photoId: string,
    bibs: string[],
  ): Promise<void> {
    try {
      // For each detected bib, create organized copies
      for (const bib of bibs) {
        await Promise.all([
          this.cloudinaryService.copyToFolder(
            sourceCloudinaryId,
            `events/${eventId}/original/dorsal-${bib}`,
            `${photoId}-original`,
            'original'
          ),
          this.cloudinaryService.copyToFolder(
            sourceCloudinaryId,
            `events/${eventId}/thumb/dorsal-${bib}`,
            `${photoId}-thumb`,
            'thumb'
          ),
          this.cloudinaryService.copyToFolder(
            sourceCloudinaryId,
            `events/${eventId}/wm/dorsal-${bib}`,
            `${photoId}-watermark`,
            'watermark'
          ),
        ]);
      }

      this.logger.log(`Foto ${photoId} organizada en ${bibs.length} carpetas de dorsales`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Error desconocido';
      const errorStack = error instanceof Error ? error.stack : undefined;
      this.logger.error(`Error organizando foto por dorsales: ${errorMessage}`, errorStack);
      // Don't throw - this shouldn't fail the entire job
    }
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job<ProcessPhotoJob>) {
    this.logger.log(`Job ${job.id} completado para foto ${job.data.photoId}`);
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<ProcessPhotoJob>, err: Error) {
    this.logger.error(`Job ${job.id} falló para foto ${job.data.photoId}: ${err.message}`);
  }

  @OnWorkerEvent('progress')
  onProgress(job: Job<ProcessPhotoJob>, progress: number) {
    this.logger.debug(`Job ${job.id} progreso: ${progress}%`);
  }
}