import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { InjectQueue } from '@nestjs/bullmq';

import { PrismaService } from '../../../api/src/common/services/prisma.service';
import { PythonFaceApiService } from '../services/python-face-api.service';
import { SpatialMatchingService } from '../services/spatial-matching.service';
import { AthleteSignatureService } from '../services/athlete-signature.service';
import { ProcessFaceJob, InferBibsJob } from '@shared/types';
import { QUEUES, FACE_RECOGNITION } from '@shared/constants';

@Processor(QUEUES.PROCESS_FACE, {
  concurrency: parseInt(process.env.FACE_WORKER_CONCURRENCY || '4')
})
export class ProcessFaceProcessor extends WorkerHost {
  private readonly logger = new Logger(ProcessFaceProcessor.name);

  constructor(
    private prisma: PrismaService,
    private pythonFaceApiService: PythonFaceApiService,
    private spatialMatchingService: SpatialMatchingService,
    private athleteSignatureService: AthleteSignatureService,
    @InjectQueue(QUEUES.INFER_BIBS) private inferBibsQueue: Queue<InferBibsJob>,
  ) {
    super();
  }

  async process(job: Job<ProcessFaceJob>): Promise<void> {
    const { photoId, eventId, imageUrl } = job.data;
    
    this.logger.log(`Processing faces for photo ${photoId} in event ${eventId}`);

    try {
      // Check if Python Face-API is ready
      if (!this.pythonFaceApiService.isReadySync()) {
        this.logger.warn(`Python Face-API not ready, skipping face processing for photo ${photoId}`);
        return;
      }

      // Step 1: Detect all faces in the photo using Python API
      job.updateProgress(25);
      const detectedFaces = await this.pythonFaceApiService.detectAllFaces(imageUrl, FACE_RECOGNITION.MAX_FACES_PER_PHOTO);
      
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
        embedding: face.embedding, // Keep as number[] for 512-dimensional embeddings
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

      // ═══════════════════════════════════════════════════════
      // Step 3: NEW - Associate faces with bibs (spatial matching)
      // ═══════════════════════════════════════════════════════
      job.updateProgress(78);

      // Get detected bibs for this photo
      const photoBibs = await this.prisma.photoBib.findMany({
        where: { photoId },
        select: {
          id: true,
          bib: true,
          confidence: true,
          bbox: true
        }
      });

      if (photoBibs.length > 0 && detectedFaces.length > 0) {
        this.logger.log(
          `Photo ${photoId}: Matching ${detectedFaces.length} face(s) with ${photoBibs.length} bib(s)`
        );

        // Perform spatial matching
        const matches = this.spatialMatchingService.matchFacesWithBibs(
          detectedFaces.map(f => ({
            bbox: f.bbox,
            embedding: f.embedding,
            confidence: f.confidence
          })),
          photoBibs.map(pb => ({
            bib: pb.bib,
            confidence: Number(pb.confidence),
            bbox: pb.bbox as [number, number, number, number]
          }))
        );

        // Save face-bib associations
        const savedFaces = await this.prisma.faceEmbedding.findMany({
          where: { photoId },
          orderBy: { createdAt: 'asc' } // Same order as detectedFaces
        });

        for (const match of matches) {
          const faceEmbedding = savedFaces[match.faceIndex];
          const photoBib = photoBibs.find(pb => pb.bib === match.bibValue);

          if (faceEmbedding && photoBib) {
            await this.prisma.faceBibAssociation.create({
              data: {
                faceEmbeddingId: faceEmbedding.id,
                photoBibId: photoBib.id,
                photoId,
                eventId,
                bib: match.bibValue,
                spatialScore: match.spatialScore,
                method: 'SPATIAL'
              }
            });

            // Update athlete signature
            await this.athleteSignatureService.updateAthleteSignature(
              eventId,
              match.bibValue,
              faceEmbedding.embedding,
              Number(photoBib.confidence)
            );
          }
        }

        this.logger.log(
          `Created ${matches.length} face-bib associations for photo ${photoId}`
        );
      }

      // ═══════════════════════════════════════════════════════
      // Step 4: NEW - Enqueue inference job if no bibs detected
      // ═══════════════════════════════════════════════════════
      if (photoBibs.length === 0 && detectedFaces.length > 0) {
        this.logger.log(
          `Photo ${photoId}: No bibs detected but ${detectedFaces.length} face(s) found - enqueueing inference job`
        );

        await this.inferBibsQueue.add(
          'infer-bibs',
          {
            photoId,
            eventId
          } as InferBibsJob,
          {
            attempts: 3,
            backoff: {
              type: 'exponential',
              delay: 10000 // Start with 10s delay
            },
            removeOnComplete: 10,
            removeOnFail: 5
          }
        );
      }

      // Step 5: Update BatchUploadJob face processing counter
      job.updateProgress(85);
      const updatedPhoto = await this.prisma.photo.findUnique({
        where: { id: photoId },
        select: { batchJobId: true },
      });

      if (updatedPhoto?.batchJobId) {
        await this.prisma.batchUploadJob.update({
          where: { id: updatedPhoto.batchJobId },
          data: { 
            faceFiles: { increment: 1 },
            updatedAt: new Date()
          },
        });
        this.logger.debug(`Face processing completed for photo ${photoId}, batch job updated`);
      }

      // Step 4: Complete job
      job.updateProgress(100);
      this.logger.log(`Face processing completed for photo ${photoId}`);

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const errorStack = error instanceof Error ? error.stack : undefined;
      this.logger.error(`Error processing faces for photo ${photoId}: ${errorMessage}`, errorStack);

      // Update failed faces counter in BatchUploadJob
      try {
        const updatedPhoto = await this.prisma.photo.findUnique({
          where: { id: photoId },
          select: { batchJobId: true },
        });

        if (updatedPhoto?.batchJobId) {
          await this.prisma.batchUploadJob.update({
            where: { id: updatedPhoto.batchJobId },
            data: { 
              failedFaces: { increment: 1 },
              updatedAt: new Date()
            },
          });
          this.logger.debug(`Face processing failed for photo ${photoId}, batch job updated with failure`);
        }
      } catch (updateError) {
        this.logger.warn(`Failed to update batch job after face processing error: ${updateError instanceof Error ? updateError.message : 'Unknown error'}`);
      }

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