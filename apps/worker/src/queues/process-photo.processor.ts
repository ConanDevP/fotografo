import { InjectQueue, OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job, Queue } from 'bullmq';

import { PrismaService } from '../../../api/src/common/services/prisma.service';
import { OcrGeminiService } from '../services/ocr-gemini.service';
import { ImagesService } from '../services/images.service';
import { BatchProgressService } from '../services/batch-progress.service';
import { InferBibsJob, ProcessFaceJob, ProcessPhotoJob, SendBibEmailJob } from '@shared/types';
import { JOBS, QUEUES } from '@shared/constants';

@Processor(QUEUES.PROCESS_PHOTO, {
  concurrency: parseInt(process.env.WORKER_CONCURRENCY || '8'),
})
export class ProcessPhotoProcessor extends WorkerHost {
  private readonly logger = new Logger(ProcessPhotoProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ocrService: OcrGeminiService,
    private readonly imagesService: ImagesService,
    private readonly batchProgress: BatchProgressService,
    @InjectQueue(QUEUES.PROCESS_FACE) private readonly faceQueue: Queue<ProcessFaceJob>,
    @InjectQueue(QUEUES.INFER_BIBS) private readonly inferQueue: Queue<InferBibsJob>,
    @InjectQueue(QUEUES.SEND_BIB_EMAIL) private readonly emailQueue: Queue<SendBibEmailJob>,
  ) {
    super();
  }

  async process(job: Job<ProcessPhotoJob>): Promise<void> {
    const { photoId, eventId, objectKey } = job.data;
    const startedAt = Date.now();
    const isFinalAttempt = job.attemptsMade + 1 >= Number(job.opts.attempts || 1);

    this.logger.log(
      `[Job ${job.id}] Procesando foto ${photoId}; intento ${job.attemptsMade + 1}/${job.opts.attempts || 1}`,
    );

    try {
      let [photo, event] = await Promise.all([
        this.prisma.photo.findUnique({ where: { id: photoId } }),
        this.prisma.event.findUnique({
          where: { id: eventId },
          include: { workspace: { select: { name: true, slug: true } } },
        }),
      ]);

      if (!photo || !event) throw new Error('Foto o evento no encontrado');

      if (photo.processingCompletedAt && photo.status === 'PROCESSED') {
        if (!photo.faceProcessedAt && !photo.faceFailedAt) {
          const imageUrl = await this.imagesService.getOptimizedImageForOCR(objectKey);
          await this.enqueueFaceProcessing(photoId, eventId, imageUrl);
        }
        await this.batchProgress.reconcileForPhoto(photoId);
        await job.updateProgress(100);
        return;
      }

      await job.updateProgress(20);
      if (!photo.derivativesProcessedAt || !photo.thumbUrl || !photo.watermarkUrl) {
        try {
          const derivatives = await this.imagesService.generateDerivatives(
            objectKey,
            eventId,
            photoId,
            event.workspace ? `${event.workspace.name} · LucilaMon` : 'lucilamon.com',
          );
          const processedAt = new Date();
          photo = await this.prisma.photo.update({
            where: { id: photoId },
            data: {
              thumbUrl: derivatives.thumbUrl,
              watermarkUrl: derivatives.watermarkUrl,
              watermarkThumbUrl: derivatives.watermarkThumbUrl,
              derivativesProcessedAt: processedAt,
              watermarkFailedAt: null,
              derivedBytes: derivatives.derivedBytes,
            },
          });

          // Las derivadas también ocupan R2. Este bloque solo se ejecuta cuando
          // aún no había derivadas, así que un reintento no cuenta dos veces.
          if (photo.photographerWorkspaceId && derivatives.derivedBytes) {
            await this.prisma.workspace
              .update({
                where: { id: photo.photographerWorkspaceId },
                data: { storageBytesUsed: { increment: BigInt(derivatives.derivedBytes) } },
              })
              .catch(error =>
                this.logger.warn(
                  `No se pudo contabilizar el consumo de derivadas de ${photoId}: ${
                    error instanceof Error ? error.message : 'error desconocido'
                  }`,
                ),
              );
          }
          await this.prisma.batchUploadItem.updateMany({
            where: { photoId },
            data: { derivativesProcessedAt: processedAt, watermarkFailedAt: null, error: null },
          });
        } catch (error) {
          if (isFinalAttempt) {
            const failedAt = new Date();
            await Promise.all([
              this.prisma.photo.updateMany({
                where: { id: photoId },
                data: { watermarkFailedAt: failedAt },
              }),
              this.prisma.batchUploadItem.updateMany({
                where: { photoId },
                data: { watermarkFailedAt: failedAt },
              }),
            ]);
          }
          throw error;
        }
      } else {
        await this.prisma.batchUploadItem.updateMany({
          where: { photoId, derivativesProcessedAt: null },
          data: { derivativesProcessedAt: photo.derivativesProcessedAt, watermarkFailedAt: null },
        });
      }

      await job.updateProgress(40);
      const ocrImageUrl = await this.imagesService.getOptimizedImageForOCR(objectKey);

      if (!photo.ocrProcessedAt && !photo.ocrFailedAt) {
        try {
          let ocrResult = await this.ocrService.detectBibs(
            ocrImageUrl,
            event.bibRules as any,
            'flash',
          );

          // Escalado a un modelo mayor cuando el rápido no lee ningún dorsal.
          // Solo se paga en las fotografías que lo necesitan, y evita que una
          // foto se quede sin dorsal para siempre esperando un reproceso manual.
          if (!ocrResult.bibs?.length) {
            this.logger.log(`[Job ${job.id}] Sin dorsales con flash; reintentando con pro`);
            try {
              const escalated = await this.ocrService.detectBibs(
                ocrImageUrl,
                event.bibRules as any,
                'pro',
              );
              if (escalated.bibs?.length) {
                ocrResult = escalated;
                this.logger.log(`[Job ${job.id}] pro encontró ${escalated.bibs.length} dorsal(es)`);
              }
            } catch (escalationError) {
              // El escalado es una mejora, no un requisito: si falla, la foto
              // sigue su curso con el resultado de flash.
              this.logger.warn(
                `[Job ${job.id}] Escalado a pro falló: ${escalationError instanceof Error ? escalationError.message : 'error desconocido'}`,
              );
            }
          }

          if (ocrResult.bibs?.length) {
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
                geminiImageWidth: ocrResult.imageDimensions?.width,
                geminiImageHeight: ocrResult.imageDimensions?.height,
              })),
              skipDuplicates: true,
            });
          }

          const processedAt = new Date();
          photo = await this.prisma.photo.update({
            where: { id: photoId },
            data: { ocrProcessedAt: processedAt, ocrFailedAt: null },
          });
          await this.prisma.batchUploadItem.updateMany({
            where: { photoId },
            data: { ocrProcessedAt: processedAt, ocrFailedAt: null },
          });
        } catch (error) {
          if (!isFinalAttempt) throw error;

          const failedAt = new Date();
          photo = await this.prisma.photo.update({
            where: { id: photoId },
            data: { ocrFailedAt: failedAt },
          });
          await this.prisma.batchUploadItem.updateMany({
            where: { photoId },
            data: { ocrFailedAt: failedAt },
          });
          this.logger.warn(`OCR agotó sus reintentos para ${photoId}; la foto seguirá disponible`);
        }
      }

      await job.updateProgress(70);
      await this.enqueueBibNotifications(photoId, eventId);

      let faceQueuedOrFinished = Boolean(photo.faceProcessedAt || photo.faceFailedAt);
      if (!faceQueuedOrFinished) {
        try {
          await this.enqueueFaceProcessing(photoId, eventId, ocrImageUrl);
          faceQueuedOrFinished = true;
        } catch (error) {
          if (!isFinalAttempt) throw error;
          const failedAt = new Date();
          photo = await this.prisma.photo.update({
            where: { id: photoId },
            data: { faceFailedAt: failedAt },
          });
          await this.prisma.batchUploadItem.updateMany({
            where: { photoId },
            data: { faceFailedAt: failedAt },
          });
          this.logger.warn(`No se pudo encolar reconocimiento facial para ${photoId}`);
        }
      }

      await this.enqueueInferenceGuard(photoId, eventId);

      await job.updateProgress(95);
      const completedAt = new Date();
      const completedPhoto = await this.prisma.photo.update({
        where: { id: photoId },
        data: { status: 'PROCESSED', processingCompletedAt: completedAt },
        select: { faceProcessedAt: true, faceFailedAt: true },
      });
      await this.prisma.batchUploadItem.updateMany({
        where: { photoId },
        data: {
          status: completedPhoto.faceProcessedAt || completedPhoto.faceFailedAt ? 'COMPLETED' : 'PROCESSING',
          error: null,
        },
      });

      await this.batchProgress.reconcileForPhoto(photoId);
      await job.updateProgress(100);
      this.logger.log(`[Job ${job.id}] Foto ${photoId} procesada en ${Date.now() - startedAt}ms`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Error desconocido';
      this.logger.error(`[Job ${job.id}] Falló foto ${photoId}: ${errorMessage}`);

      if (isFinalAttempt) {
        await Promise.all([
          this.prisma.photo.updateMany({
            where: { id: photoId },
            data: { status: 'FAILED' },
          }),
          this.prisma.batchUploadItem.updateMany({
            where: { photoId },
            data: { status: 'FAILED', error: errorMessage.slice(0, 1000) },
          }),
        ]).catch(() => undefined);
      }
      await this.batchProgress.reconcileForPhoto(photoId).catch(() => undefined);
      throw error;
    }
  }

  private async enqueueBibNotifications(photoId: string, eventId: string): Promise<void> {
    const bibs = await this.prisma.photoBib.findMany({
      where: { photoId },
      select: { bib: true },
    });
    const uniqueBibs = [...new Set(bibs.map(item => item.bib))];
    if (!uniqueBibs.length) return;

    const subscriptions = await this.prisma.bibSubscription.findMany({
      where: { eventId, bib: { in: uniqueBibs } },
    });
    for (const subscription of subscriptions) {
      await this.emailQueue.add(
        JOBS.SEND_BIB_EMAIL,
        {
          kind: 'BIB_NOTIFICATION',
          eventId,
          bib: subscription.bib,
          email: subscription.email,
          photoIds: [photoId],
        },
        {
          jobId: `bib-${subscription.id}-${photoId}`,
          attempts: 3,
          backoff: { type: 'exponential', delay: 2000 },
          removeOnComplete: 1000,
          removeOnFail: 500,
        },
      );
    }
  }

  private async enqueueFaceProcessing(photoId: string, eventId: string, imageUrl: string): Promise<void> {
    const jobId = `face-${photoId}`;
    const existingJob = await this.faceQueue.getJob(jobId);
    if (existingJob) {
      const state = await existingJob.getState();
      if (state !== 'failed') return;
      await existingJob.remove();
    }

    await this.faceQueue.add(
      JOBS.PROCESS_FACE,
      { photoId, eventId, imageUrl },
      {
        jobId,
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: true,
        removeOnFail: 50,
      },
    );
  }

  private async enqueueInferenceGuard(photoId: string, eventId: string): Promise<void> {
    await this.inferQueue.add(
      JOBS.INFER_BIBS,
      { photoId, eventId },
      {
        jobId: `infer-guard-${photoId}`,
        delay: 45_000,
        attempts: 2,
        backoff: { type: 'exponential', delay: 10_000 },
        removeOnComplete: 100,
        removeOnFail: 50,
      },
    ).catch(error => {
      this.logger.warn(
        `No se pudo encolar inferencia para ${photoId}: ${error instanceof Error ? error.message : 'error desconocido'}`,
      );
    });
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job<ProcessPhotoJob>) {
    this.logger.log(`Job ${job.id} completado para foto ${job.data.photoId}`);
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<ProcessPhotoJob>, err: Error) {
    this.logger.error(`Job ${job.id} falló para foto ${job.data.photoId}: ${err.message}`);
  }
}
