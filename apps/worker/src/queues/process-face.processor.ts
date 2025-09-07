import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';

import { PrismaService } from '../../../api/src/common/services/prisma.service';
import { FaceApiService } from '../services/face-api.service';
import { ProcessFaceJob } from '@shared/types';
import { QUEUES, FACE_RECOGNITION } from '@shared/constants';

@Processor(QUEUES.PROCESS_FACE)
export class ProcessFaceProcessor extends WorkerHost {
  private readonly logger = new Logger(ProcessFaceProcessor.name);

  constructor(
    private prisma: PrismaService,
    private faceApiService: FaceApiService,
  ) {
    super();
  }

  async process(job: Job<ProcessFaceJob>): Promise<void> {
    const { photoId, eventId, imageUrl } = job.data;
    
    this.logger.log(`Processing faces for photo ${photoId} in event ${eventId}`);

    try {
      // Check if Face-API is ready
      if (!this.faceApiService.isReady()) {
        this.logger.warn(`Face-API not ready, skipping face processing for photo ${photoId}`);
        return;
      }

      // Step 1: Detect all faces in the photo
      job.updateProgress(25);
      const detectedFaces = await this.faceApiService.detectAllFaces(imageUrl);
      
      if (detectedFaces.length === 0) {
        this.logger.log(`No faces detected in photo ${photoId}`);
        return;
      }

      // Limit number of faces to prevent abuse
      const facesToProcess = detectedFaces.slice(0, FACE_RECOGNITION.MAX_FACES_PER_PHOTO);
      if (facesToProcess.length < detectedFaces.length) {
        this.logger.warn(`Photo ${photoId} had ${detectedFaces.length} faces, limited to ${FACE_RECOGNITION.MAX_FACES_PER_PHOTO}`);
      }

      this.logger.log(`Detected ${facesToProcess.length} faces in photo ${photoId}`);

      // Step 2: Save face embeddings to database
      job.updateProgress(50);
      
      const faceEmbeddingData = facesToProcess.map(face => ({
        photoId,
        eventId,
        embedding: face.embedding.map(val => Number(val.toFixed(12))), // Convert to Decimal precision
        confidence: Number(face.confidence.toFixed(3)),
        bbox: face.bbox,
        landmarks: face.landmarks || null,
        age: face.age || null,
        gender: face.gender || null,
      }));

      // Batch insert all face embeddings
      await this.prisma.faceEmbedding.createMany({
        data: faceEmbeddingData,
        skipDuplicates: true,
      });

      job.updateProgress(75);
      this.logger.log(`Saved ${faceEmbeddingData.length} face embeddings for photo ${photoId}`);

      // Step 3: Update job progress and complete
      job.updateProgress(100);
      this.logger.log(`Face processing completed for photo ${photoId}`);

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const errorStack = error instanceof Error ? error.stack : undefined;
      this.logger.error(`Error processing faces for photo ${photoId}: ${errorMessage}`, errorStack);

      // Don't throw error - face processing failure shouldn't fail the entire photo processing
      // The photo can still be searchable by bib number
      this.logger.warn(`Continuing without face data for photo ${photoId}`);
    }
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job<ProcessFaceJob>) {
    this.logger.log(`Face processing job ${job.id} completed for photo ${job.data.photoId}`);
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<ProcessFaceJob>, err: Error) {
    this.logger.error(`Face processing job ${job.id} failed for photo ${job.data.photoId}: ${err.message}`);
  }

  @OnWorkerEvent('progress')
  onProgress(job: Job<ProcessFaceJob>, progress: number) {
    this.logger.debug(`Face processing job ${job.id} progress: ${progress}%`);
  }
}