import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { InjectQueue } from '@nestjs/bullmq';

import { PrismaService } from '../../../api/src/common/services/prisma.service';
import { PythonFaceApiService } from '../services/python-face-api.service';
import { SpatialMatchingService } from '../services/spatial-matching.service';
import { AthleteSignatureService } from '../services/athlete-signature.service';
import { FaceKnnService } from '../services/face-knn.service';
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
    private faceKnnService: FaceKnnService,
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

      // Get detected bibs for this photo (needed for both scenarios)
      job.updateProgress(30);
      const photoBibs = await this.prisma.photoBib.findMany({
        where: { photoId },
        select: {
          id: true,
          bib: true,
          confidence: true,
          bbox: true,
          geminiImageWidth: true,
          geminiImageHeight: true
        }
      });

      // Fetch photo dimensions to improve bbox scaling accuracy
      const photoDimensions = await this.prisma.photo.findUnique({
        where: { id: photoId },
        select: { width: true, height: true }
      });

      // ═══════════════════════════════════════════════════════
      // BIDIRECTIONAL LINKING - Case 1: Bib detected but NO face detected
      // Check if any detected bib has a known face signature
      // ═══════════════════════════════════════════════════════
      if (detectedFaces.length === 0 && photoBibs.length > 0) {
        this.logger.log(
          `Photo ${photoId}: ${photoBibs.length} bib(s) detected but no faces - checking for known face signatures`
        );

        // Get athlete signatures for detected bibs
        const signatures = await this.athleteSignatureService.getReliableSignaturesForBibs(
          eventId,
          photoBibs.map(pb => pb.bib)
        );

        if (signatures.length > 0) {
          this.logger.log(
            `Photo ${photoId}: Found ${signatures.length} athlete signature(s) for detected bibs - attempting enhanced face detection`
          );

          // Try enhanced face detection with lower confidence threshold
          // This might catch faces that were missed in the initial detection
          const enhancedFaces = await this.pythonFaceApiService.detectAllFaces(
            imageUrl,
            FACE_RECOGNITION.MAX_FACES_PER_PHOTO,
            0.3 // Lower confidence threshold for this retry
          );

          if (enhancedFaces.length > 0) {
            this.logger.log(
              `Photo ${photoId}: Enhanced detection found ${enhancedFaces.length} face(s) using lower confidence threshold`
            );

            // Use enhanced faces for processing
            detectedFaces.push(...enhancedFaces);
          } else {
            this.logger.log(
              `Photo ${photoId}: No faces found even with enhanced detection - creating signature-based associations if available`
            );

            const createdAssociations = await this.createSignatureBasedAssociations(
              photoId,
              eventId,
              photoBibs,
              signatures
            );

            if (createdAssociations > 0) {
              this.logger.log(
                `Photo ${photoId}: Signature-based associations created for ${createdAssociations} bib(s)`
              );
            } else {
              this.logger.log(
                `Photo ${photoId}: No signature-based associations created (missing signatures or already linked)`
              );
            }
          }
        } else {
          this.logger.log(
            `Photo ${photoId}: No established signatures found for detected bibs`
          );
        }
      }

      // If still no faces after enhanced detection, return early
      if (detectedFaces.length === 0) {
        this.logger.log(`No faces detected in photo ${photoId} (even after enhanced detection)`);
        return;
      }

      // Limit number of faces to prevent abuse
      const facesToProcess = detectedFaces.slice(0, FACE_RECOGNITION.MAX_FACES_PER_PHOTO);
      if (facesToProcess.length < detectedFaces.length) {
        this.logger.warn(`Photo ${photoId} had ${detectedFaces.length} faces, limited to ${FACE_RECOGNITION.MAX_FACES_PER_PHOTO}`);
      }

      this.logger.log(`Detected ${facesToProcess.length} faces in photo ${photoId}`);

      // Log face bboxes for debugging
      facesToProcess.forEach((face, idx) => {
        this.logger.log(`   👤 Face ${idx}: bbox=[${face.bbox.join(', ')}], confidence=${face.confidence.toFixed(3)}`);
      });

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

      if (photoBibs.length > 0 && facesToProcess.length > 0) {
        this.logger.log(
          `🔗 [SPATIAL-MATCH] Photo ${photoId}: Matching ${facesToProcess.length} face(s) with ${photoBibs.length} bib(s)`
        );

        const median = (values: number[]) => {
          if (values.length === 0) {
            return undefined;
          }
          const sorted = [...values].sort((a, b) => a - b);
          const mid = Math.floor(sorted.length / 2);
          if (sorted.length % 2 === 0) {
            return (sorted[mid - 1] + sorted[mid]) / 2;
          }
          return sorted[mid];
        };

        // Calculate scale factor dynamically from Gemini dimensions
        // Use the first bib's dimensions (all bibs from same photo have same dimensions)
        const firstBib = photoBibs[0];
        let SCALE_FACTOR_X = 1;
        let SCALE_FACTOR_Y = 1;

        if (
          firstBib.geminiImageWidth &&
          firstBib.geminiImageHeight &&
          photoDimensions?.width &&
          photoDimensions?.height
        ) {
          SCALE_FACTOR_X = photoDimensions.width / firstBib.geminiImageWidth;
          SCALE_FACTOR_Y = photoDimensions.height / firstBib.geminiImageHeight;

          this.logger.log(
            `   🔢 Calculated scale factors using photo dimensions: ` +
            `X=${SCALE_FACTOR_X.toFixed(3)}, Y=${SCALE_FACTOR_Y.toFixed(3)} ` +
            `(Gemini: ${firstBib.geminiImageWidth}×${firstBib.geminiImageHeight}, ` +
            `Photo: ${photoDimensions.width}×${photoDimensions.height})`
          );
        } else if (firstBib.geminiImageWidth && firstBib.geminiImageHeight) {
          // Fallback: estimate scale from detected coordinates (legacy behaviour)
          const maxFaceX = Math.max(...facesToProcess.map(f => f.bbox[0] + f.bbox[2]));
          const maxFaceY = Math.max(...facesToProcess.map(f => f.bbox[1] + f.bbox[3]));
          const maxBibX = Math.max(...photoBibs.map(pb => {
            const bbox = pb.bbox as [number, number, number, number];
            return bbox[0] + bbox[2];
          }));
          const maxBibY = Math.max(...photoBibs.map(pb => {
            const bbox = pb.bbox as [number, number, number, number];
            return bbox[1] + bbox[3];
          }));

          const estimatedOriginalWidth = Math.max(maxFaceX, maxBibX) * 1.15;
          const estimatedOriginalHeight = Math.max(maxFaceY, maxBibY) * 1.15;

          SCALE_FACTOR_X = estimatedOriginalWidth / firstBib.geminiImageWidth;
          SCALE_FACTOR_Y = estimatedOriginalHeight / firstBib.geminiImageHeight;

          this.logger.warn(
            `   ⚠️  Approximated scale factors: X=${SCALE_FACTOR_X.toFixed(3)}, Y=${SCALE_FACTOR_Y.toFixed(3)} ` +
            `(Gemini dims available pero foto sin dimensiones guardadas)`
          );
        } else {
          this.logger.warn(
            `   ⚠️  No Gemini dimensions stored - using fallback scale factor 1.953125`
          );
          SCALE_FACTOR_X = 1.953125;
          SCALE_FACTOR_Y = 1.953125;
        }

        // REMOVED BUGGY MEDIAN-BASED SCALE ADJUSTMENT
        // The previous code was comparing face centers (in real photo coords) with bib centers (in Gemini coords)
        // This caused incorrect scaling. We now trust the calculated SCALE_FACTOR_X/Y from photo dimensions.
        this.logger.log(
          `   ✅ Using scale factors: X=${SCALE_FACTOR_X.toFixed(3)}, Y=${SCALE_FACTOR_Y.toFixed(3)}`
        );

        // Log bib details with scaled coordinates
        photoBibs.forEach(pb => {
          const bbox = pb.bbox as [number, number, number, number];
          const scaled = [
            Math.round(bbox[0] * SCALE_FACTOR_X),
            Math.round(bbox[1] * SCALE_FACTOR_Y),
            Math.round(bbox[2] * SCALE_FACTOR_X),
            Math.round(bbox[3] * SCALE_FACTOR_Y)
          ];
          this.logger.log(
            `   📍 Bib detected: "${pb.bib}" (confidence: ${Number(pb.confidence).toFixed(3)}, bbox: ${JSON.stringify(bbox)} -> scaled: ${JSON.stringify(scaled)})`
          );
        });

        // Perform spatial matching with scaled bib coordinates
        const matches = this.spatialMatchingService.matchFacesWithBibs(
          facesToProcess.map(f => ({
            bbox: f.bbox,
            embedding: f.embedding,
            confidence: f.confidence
          })),
          photoBibs.map(pb => {
            const bbox = pb.bbox as [number, number, number, number];
            return {
              bib: pb.bib,
              confidence: Number(pb.confidence),
              bbox: [
                bbox[0] * SCALE_FACTOR_X,
                bbox[1] * SCALE_FACTOR_Y,
                bbox[2] * SCALE_FACTOR_X,
                bbox[3] * SCALE_FACTOR_Y
              ] as [number, number, number, number]
            };
          })
        );

        this.logger.log(`   🎯 Spatial matching found ${matches.length} face-bib match(es)`);

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

            this.logger.log(
              `   ✅ Created FaceBibAssociation: Face ${match.faceIndex} ↔ Bib "${match.bibValue}" (spatialScore: ${match.spatialScore.toFixed(3)})`
            );

            // Update athlete signature
            // Pass undefined for geminiConfidence to bypass confidence check
            // Spatial matching is already a strong validation
            this.logger.log(
              `   🎭 Updating AthleteSignature for bib "${match.bibValue}" (bypassing Gemini confidence check)`
            );

            await this.athleteSignatureService.updateAthleteSignature(
              eventId,
              match.bibValue,
              faceEmbedding.embedding,
              undefined // Don't filter by Gemini confidence when we have spatial match
            );
          }
        }

        this.logger.log(
          `✅ [SPATIAL-MATCH] Created ${matches.length} face-bib associations for photo ${photoId}`
        );

        if (matches.length > 0) {
          this.faceKnnService.invalidate(eventId);
        }
      } else if (photoBibs.length === 0 && facesToProcess.length > 0) {
        this.logger.log(
          `⚠️  [SPATIAL-MATCH] Photo ${photoId}: ${facesToProcess.length} face(s) detected but NO bibs - skipping spatial matching`
        );
      } else if (photoBibs.length > 0 && facesToProcess.length === 0) {
        this.logger.log(
          `⚠️  [SPATIAL-MATCH] Photo ${photoId}: ${photoBibs.length} bib(s) detected but NO faces - skipping spatial matching`
        );
      }

      // ═══════════════════════════════════════════════════════
      // Step 4: NEW - ALWAYS enqueue inference job when faces detected
      // This creates face-to-bib correlations for ALL photos with faces
      // ═══════════════════════════════════════════════════════
      if (facesToProcess.length > 0) {
        const hasBibs = photoBibs.length > 0;
        this.logger.log(
          `📤 [INFERENCE-ENQUEUE] Photo ${photoId}: ${facesToProcess.length} face(s) detected ${hasBibs ? 'WITH bibs' : 'WITHOUT bibs'} - enqueueing inference job`
        );

        await this.inferBibsQueue.add(
          'infer-bibs',
          {
            photoId,
            eventId
          } as InferBibsJob,
          {
            delay: 5000, // 5 seconds to ensure KNN cache is updated
            attempts: 3,
            backoff: {
              type: 'exponential',
              delay: 5000 // Start with 5s delay
            },
            removeOnComplete: 10,
            removeOnFail: 5
          }
        );

        this.logger.log(`   ✅ Inference job enqueued successfully for photo ${photoId}`);
      } else {
        this.logger.log(
          `⏭️  [INFERENCE-ENQUEUE] Photo ${photoId}: No faces detected - skipping inference job`
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

  private async createSignatureBasedAssociations(
    photoId: string,
    eventId: string,
    photoBibs: Array<{
      id: bigint;
      bib: string;
      confidence: any;
      bbox: any;
      geminiImageWidth: number | null;
      geminiImageHeight: number | null;
    }>,
    signatures: Array<{
      id: string;
      eventId: string;
      bib: string;
      faceSignature: number[];
      sampleCount: number;
      confidence: any;
    }>
  ): Promise<number> {
    if (!signatures || signatures.length === 0) {
      return 0;
    }

    const signatureMap = new Map(signatures.map(signature => [signature.bib, signature]));
    const bibsWithSignature = photoBibs.filter(pb => signatureMap.has(pb.bib));

    if (bibsWithSignature.length === 0) {
      return 0;
    }

    const existingAssociations = await this.prisma.faceBibAssociation.findMany({
      where: {
        photoId,
        bib: { in: bibsWithSignature.map(pb => pb.bib) },
      },
      select: { bib: true },
    });

    const alreadyLinked = new Set(existingAssociations.map(item => item.bib));
    let created = 0;

    for (const pb of bibsWithSignature) {
      if (alreadyLinked.has(pb.bib)) {
        continue;
      }

      const signature = signatureMap.get(pb.bib);
      if (!signature || !Array.isArray(signature.faceSignature) || signature.faceSignature.length === 0) {
        continue;
      }

      const syntheticEmbedding = await this.prisma.faceEmbedding.create({
        data: {
          photoId,
          eventId,
          embedding: signature.faceSignature,
          confidence: Number(signature.confidence ?? 0.7),
          bbox: null,
          landmarks: null,
          age: null,
          gender: null,
        },
      });

      await this.prisma.faceBibAssociation.create({
        data: {
          faceEmbeddingId: syntheticEmbedding.id,
          photoBibId: pb.id,
          photoId,
          eventId,
          bib: pb.bib,
          spatialScore: Number(signature.confidence ?? 0.7),
          method: 'INFERRED',
        },
      });

      created++;
    }

    if (created > 0) {
      this.faceKnnService.invalidate(eventId);
    }

    return created;
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job<ProcessFaceJob>) {
    this.logger.log(`Face processing job ${job.id} completed for photo ${job.data.photoId}`);
  }

  @OnWorkerEvent('active')
  onActive(job: Job<ProcessFaceJob>) {
    this.logger.log(`Face processing job ${job.id} started for photo ${job.data.photoId}`);
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
