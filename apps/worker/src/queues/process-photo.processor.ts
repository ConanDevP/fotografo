import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';

import { PrismaService } from '../../../api/src/common/services/prisma.service';
import { OcrGeminiService } from '../services/ocr-gemini.service';
import { ImagesService } from '../services/images.service';
import { CloudinaryService } from '../../../api/src/common/services/cloudinary.service';
import { ProcessPhotoJob, ProcessFaceJob } from '@shared/types';
import { QUEUES } from '@shared/constants';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

@Processor(QUEUES.PROCESS_PHOTO)
export class ProcessPhotoProcessor extends WorkerHost {
  private readonly logger = new Logger(ProcessPhotoProcessor.name);

  constructor(
    private prisma: PrismaService,
    private ocrService: OcrGeminiService,
    private imagesService: ImagesService,
    private cloudinaryService: CloudinaryService,
    @InjectQueue(QUEUES.PROCESS_FACE) private faceQueue: Queue<ProcessFaceJob>,
  ) {
    super();
  }

  async process(job: Job<ProcessPhotoJob>): Promise<void> {
    const { photoId, eventId, objectKey } = job.data;
    const startTime = Date.now();
    
    this.logger.log(`[Job ${job.id}] Iniciando procesamiento de foto ${photoId} para evento ${eventId}`);

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
      let watermarkSuccess = false;
      try {
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
        
        watermarkSuccess = true;
        this.logger.debug(`[Job ${job.id}] Watermark generada exitosamente para foto ${photoId}`);
      } catch (error) {
        this.logger.error(`[Job ${job.id}] Error generando watermark para foto ${photoId}: ${error instanceof Error ? error.message : 'Unknown error'}`);
        // Continue processing, but mark watermark as failed
      }

      // Step 2: Get optimized image for OCR
      job.updateProgress(40);
      const ocrImageUrl = await this.imagesService.getOptimizedImageForOCR(objectKey);

      // Step 3: Perform OCR with Gemini
      job.updateProgress(60);
      let geminiSuccess = false;
      let ocrResult: any;
      try {
        ocrResult = await this.ocrService.detectBibs(
          ocrImageUrl,
          event.bibRules as any,
          'flash' // Use flash model by default
        );
        geminiSuccess = true;
        this.logger.debug(`[Job ${job.id}] Gemini OCR procesado exitosamente para foto ${photoId}, ${ocrResult.bibs?.length || 0} dorsales detectados`);
      } catch (error) {
        this.logger.error(`[Job ${job.id}] Error en Gemini OCR para foto ${photoId}: ${error instanceof Error ? error.message : 'Unknown error'}`);
        ocrResult = { bibs: [] }; // Set empty result to continue processing
      }

      // Step 4: Save detected bibs to database
      job.updateProgress(70);
      if (ocrResult.bibs && ocrResult.bibs.length > 0) {
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
        const uniqueBibs: string[] = [...new Set(ocrResult.bibs.map((b: { value: string }) => b.value) as string[])];
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

      // Step 7: Process facial recognition (parallel to OCR)
      job.updateProgress(85);
      let faceProcessingEnqueued = false;
      try {
        await this.enqueueFaceProcessing(photoId, eventId, ocrImageUrl);
        faceProcessingEnqueued = true;
        this.logger.log(`[Job ${job.id}] Face processing enqueued for photo ${photoId}`);
      } catch (error) {
        // Don't fail the entire job if face processing fails
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        this.logger.warn(`[Job ${job.id}] Failed to enqueue face processing for photo ${photoId}: ${errorMessage}`);
      }

      // Step 8: Mark photo as processed
      job.updateProgress(100);
      await this.prisma.photo.update({
        where: { id: photoId },
        data: { status: 'PROCESSED' },
      });

      // Update processedFiles count and pipeline tracking in BatchUploadJob
      const updatedPhoto = await this.prisma.photo.findUnique({
        where: { id: photoId },
        select: { batchJobId: true }, // Only fetch batchJobId
      });

      if (updatedPhoto?.batchJobId) {
        // Prepare pipeline increment data
        const incrementData: any = { 
          processedFiles: { increment: 1 },
          updatedAt: new Date() // Actualizar timestamp para recovery
        };

        // Track successful pipeline steps
        if (watermarkSuccess) {
          incrementData.watermarkFiles = { increment: 1 };
        } else {
          incrementData.failedWatermarks = { increment: 1 };
        }

        if (geminiSuccess) {
          incrementData.geminiFiles = { increment: 1 };
        } else {
          incrementData.failedGemini = { increment: 1 };
        }

        // Note: Face processing success will be tracked in the face processor
        // For now, we just track that it was enqueued
        if (!faceProcessingEnqueued) {
          incrementData.failedFaces = { increment: 1 };
        }

        const batchJob = await this.prisma.batchUploadJob.update({
          where: { id: updatedPhoto.batchJobId },
          data: incrementData,
        });

        this.logger.debug(`[Job ${job.id}] BatchJob ${batchJob.id} pipeline updated: W:${watermarkSuccess ? '+1' : 'fail'}, G:${geminiSuccess ? '+1' : 'fail'}, F:${faceProcessingEnqueued ? 'enq' : 'fail'}`);

        // Check if all files in the batch job are processed
        if (batchJob.processedFiles >= batchJob.totalFiles) {
          await this.prisma.batchUploadJob.update({
            where: { id: batchJob.id },
            data: { status: 'COMPLETED' },
          });
          this.logger.log(`[Job ${job.id}] Batch job ${batchJob.id} completado (${batchJob.processedFiles}/${batchJob.totalFiles})`);
        } else {
          this.logger.debug(`[Job ${job.id}] Batch job ${batchJob.id} progreso: ${batchJob.processedFiles}/${batchJob.totalFiles}`);
        }
      }

      const processingTime = Date.now() - startTime;
      this.logger.log(`[Job ${job.id}] Foto ${photoId} procesada exitosamente en ${processingTime}ms`);

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Error desconocido';
      const errorStack = error instanceof Error ? error.stack : undefined;
      const processingTime = Date.now() - startTime;
      
      this.logger.error(`[Job ${job.id}] Error procesando foto ${photoId} después de ${processingTime}ms: ${errorMessage}`, errorStack);

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

  private async enqueueFaceProcessing(photoId: string, eventId: string, imageUrl: string): Promise<void> {
    try {
      await this.faceQueue.add(
        'process-face',
        {
          photoId,
          eventId,
          imageUrl,
        } as ProcessFaceJob,
        {
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 5000,
          },
          removeOnComplete: 10,
          removeOnFail: 5,
        }
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Failed to enqueue face processing: ${errorMessage}`);
      throw error;
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