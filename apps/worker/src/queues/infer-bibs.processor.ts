import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';

import { PrismaService } from '../../../api/src/common/services/prisma.service';
import { PythonFaceApiService } from '../services/python-face-api.service';
import { InferBibsJob } from '@shared/types';
import { QUEUES, FACE_BIB_LINKING } from '@shared/constants';

@Processor(QUEUES.INFER_BIBS, {
  concurrency: parseInt(process.env.INFER_BIBS_CONCURRENCY || '2') // Lower concurrency for inference
})
export class InferBibsProcessor extends WorkerHost {
  private readonly logger = new Logger(InferBibsProcessor.name);

  constructor(
    private prisma: PrismaService,
    private pythonFaceApiService: PythonFaceApiService,
  ) {
    super();
  }

  async process(job: Job<InferBibsJob>): Promise<void> {
    const { photoId, eventId } = job.data;
    const startTime = Date.now();

    this.logger.log(`🔍 Inferring bibs for photo ${photoId} in event ${eventId}`);

    try {
      // ═══════════════════════════════════════════════════════
      // Step 1: Get faces from this photo
      // ═══════════════════════════════════════════════════════
      const faces = await this.prisma.faceEmbedding.findMany({
        where: { photoId }
      });

      if (faces.length === 0) {
        this.logger.log(`No faces found for photo ${photoId} - nothing to infer`);
        return;
      }

      // ═══════════════════════════════════════════════════════
      // Step 2: Get reliable athlete signatures from event
      // ═══════════════════════════════════════════════════════
      const signatures = await this.prisma.athleteSignature.findMany({
        where: {
          eventId,
          sampleCount: {
            gte: FACE_BIB_LINKING.MIN_SIGNATURE_SAMPLES
          }
        },
        orderBy: {
          confidence: 'desc'
        }
      });

      if (signatures.length === 0) {
        this.logger.log(
          `No reliable signatures available for event ${eventId} yet - ` +
          `skipping inference for photo ${photoId}`
        );
        return;
      }

      this.logger.log(
        `Found ${faces.length} face(s) and ${signatures.length} reliable signature(s) - ` +
        `starting inference`
      );

      // ═══════════════════════════════════════════════════════
      // Step 3: For each face, find best matching signature
      // ═══════════════════════════════════════════════════════
      let inferredCount = 0;

      for (const face of faces) {
        let bestMatch = {
          bib: null as string | null,
          distance: 999,
          confidence: 0,
          signatureId: null as string | null
        };

        // Compare this face against all signatures
        for (const signature of signatures) {
          const distance = this.pythonFaceApiService.calculateDistance(
            face.embedding,
            signature.faceSignature
          );

          // Use stricter threshold for inference
          if (
            distance < FACE_BIB_LINKING.INFERENCE_THRESHOLD &&
            distance < bestMatch.distance
          ) {
            bestMatch = {
              bib: signature.bib,
              distance,
              confidence: 1 - distance,
              signatureId: signature.id
            };
          }
        }

        // ═══════════════════════════════════════════════════════
        // Step 4: Create inferred bib if match found
        // ═══════════════════════════════════════════════════════
        if (bestMatch.bib && bestMatch.signatureId) {
          // Check if this inference already exists
          const existing = await this.prisma.inferredBib.findUnique({
            where: {
              faceEmbeddingId_bib: {
                faceEmbeddingId: face.id,
                bib: bestMatch.bib
              }
            }
          });

          if (!existing) {
            await this.prisma.inferredBib.create({
              data: {
                photoId,
                faceEmbeddingId: face.id,
                eventId,
                bib: bestMatch.bib,
                confidence: bestMatch.confidence,
                faceDistance: bestMatch.distance,
                inferredFrom: bestMatch.signatureId,
                verified: false, // Requires photographer verification
                rejected: false
              }
            });

            inferredCount++;

            this.logger.log(
              `✨ Inferred bib "${bestMatch.bib}" for face ${face.id} ` +
              `(confidence: ${bestMatch.confidence.toFixed(3)}, distance: ${bestMatch.distance.toFixed(4)})`
            );
          } else {
            this.logger.debug(
              `Inference already exists for face ${face.id} -> bib "${bestMatch.bib}"`
            );
          }
        } else {
          this.logger.debug(
            `No match found for face ${face.id} ` +
            `(best distance: ${bestMatch.distance.toFixed(4)} > threshold: ${FACE_BIB_LINKING.INFERENCE_THRESHOLD})`
          );
        }
      }

      // ═══════════════════════════════════════════════════════
      // Step 5: Log summary
      // ═══════════════════════════════════════════════════════
      const processingTime = Date.now() - startTime;

      this.logger.log(
        `✅ Inference complete for photo ${photoId}: ` +
        `${inferredCount}/${faces.length} faces matched ` +
        `(${processingTime}ms)`
      );

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const errorStack = error instanceof Error ? error.stack : undefined;
      const processingTime = Date.now() - startTime;

      this.logger.error(
        `Error inferring bibs for photo ${photoId} after ${processingTime}ms: ${errorMessage}`,
        errorStack
      );

      // Don't throw - inference failures shouldn't fail the job
      // Photos are still searchable by direct bib detection
      this.logger.warn(`Continuing without inferred bibs for photo ${photoId}`);
    }
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job<InferBibsJob>) {
    this.logger.log(
      `Inference job ${job.id} completed for photo ${job.data.photoId}`
    );
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<InferBibsJob>, err: Error) {
    this.logger.error(
      `Inference job ${job.id} failed for photo ${job.data.photoId}: ${err.message}`
    );
  }

  @OnWorkerEvent('progress')
  onProgress(job: Job<InferBibsJob>, progress: number) {
    this.logger.debug(`Inference job ${job.id} progress: ${progress}%`);
  }
}
