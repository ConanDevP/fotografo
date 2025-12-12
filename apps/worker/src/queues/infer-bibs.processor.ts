import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';

import { PrismaService } from '../../../api/src/common/services/prisma.service';
import { PythonFaceApiService } from '../services/python-face-api.service';
import { AthleteSignatureService } from '../services/athlete-signature.service';
import { FaceKnnService } from '../services/face-knn.service';
import { InferBibsJob } from '@shared/types';
import { QUEUES, FACE_BIB_LINKING } from '@shared/constants';
import { Prisma } from '@prisma/client';

@Processor(QUEUES.INFER_BIBS, {
  concurrency: parseInt(process.env.INFER_BIBS_CONCURRENCY || '2') // Lower concurrency for inference
})
export class InferBibsProcessor extends WorkerHost {
  private readonly logger = new Logger(InferBibsProcessor.name);

  constructor(
    private prisma: PrismaService,
    private pythonFaceApiService: PythonFaceApiService,
    private athleteSignatureService: AthleteSignatureService,
    private faceKnnService: FaceKnnService,
  ) {
    super();
  }

  async process(job: Job<InferBibsJob>): Promise<void> {
    const { photoId, eventId } = job.data;
    const startTime = Date.now();

    this.logger.log(`🔍 [INFERENCE-START] Photo ${photoId} in event ${eventId}`);

    try {
      // ═══════════════════════════════════════════════════════
      // Step 1: Get faces from this photo
      // ═══════════════════════════════════════════════════════
      const faces = await this.prisma.faceEmbedding.findMany({
        where: { photoId },
        select: {
          id: true,
          embedding: true,
          faceBibAssociations: {
            where: { photoId },
            select: { id: true },
          },
        },
      });

      this.logger.log(`   👤 Found ${faces.length} face embedding(s) for photo ${photoId}`);

      if (faces.length === 0) {
        this.logger.log(`   ⏭️  No faces found in FaceEmbedding table - nothing to infer`);
        return;
      }

      // Log each face for debugging
      faces.forEach((f, i) => {
        this.logger.log(`      Face ${i}: id=${f.id}, hasAssociations=${(f.faceBibAssociations?.length || 0) > 0}, embeddingLength=${f.embedding?.length || 0}`);
      });

      // Filtrar: solo inferimos para caras que NO tienen dorsal asociado en esta foto
      const facesNeedingInference = faces.filter(f => (f.faceBibAssociations?.length || 0) === 0);

      this.logger.log(`   🎯 Faces needing inference: ${facesNeedingInference.length}/${faces.length}`);

      if (facesNeedingInference.length === 0) {
        this.logger.log(`   ✅ All faces already have associations - nothing to infer`);
        return;
      }

      // ═══════════════════════════════════════════════════════
      // Step 2: Invalidate KNN cache to ensure fresh data
      // ═══════════════════════════════════════════════════════
      this.faceKnnService.invalidate(eventId);
      this.logger.log(`   🔄 KNN cache invalidated before inference`);

      // ═══════════════════════════════════════════════════════
      // Step 3: Attempt direct KNN matching using confirmed embeddings
      // ═══════════════════════════════════════════════════════
      let totalInferred = 0;

      const knnResult = await this.applyKnnMatching(eventId, photoId, facesNeedingInference);
      totalInferred += knnResult.inferredCount;
      this.logger.log(`   📊 KNN result: ${knnResult.inferredCount} inferred, ${knnResult.remainingFaces.length} remaining for fallback`);

      const fallbackFaces = knnResult.remainingFaces;

      // ═══════════════════════════════════════════════════════
      // Step 3: Fallback to legacy signature matching when KNN cannot decide
      // ═══════════════════════════════════════════════════════
      if (fallbackFaces.length > 0) {
        totalInferred += await this.applySignatureFallback(eventId, photoId, fallbackFaces);
      }

      // ═══════════════════════════════════════════════════════
      // Step 6: Log summary
      // ═══════════════════════════════════════════════════════
      const processingTime = Date.now() - startTime;

      this.logger.log(
        `✅ [INFERENCE-COMPLETE] Photo ${photoId}: ` +
        `${totalInferred}/${faces.length} faces matched and saved ` +
        `(${processingTime}ms)`
      );

      if (totalInferred === 0) {
        this.logger.warn(
          `⚠️  [INFERENCE-COMPLETE] No inferences created for photo ${photoId} - ` +
          `all matches below configured thresholds`
        );
      }

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

  @OnWorkerEvent('active')
  onActive(job: Job<InferBibsJob>) {
    this.logger.log(
      `Inference job ${job.id} started for photo ${job.data.photoId}`
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

  private async applyKnnMatching(
    eventId: string,
    photoId: string,
    faces: Array<Prisma.FaceEmbeddingGetPayload<{ select: { id: true; embedding: true } }>>
  ): Promise<{ inferredCount: number; remainingFaces: typeof faces }> {
    let inferredCount = 0;
    const remainingFaces: typeof faces = [];

    this.logger.log(`   🤖 Running KNN matching for ${faces.length} face(s)`);
    this.logger.log(`   📋 KNN thresholds: STRICT=${FACE_BIB_LINKING.KNN_STRICT_DISTANCE}, RELAXED=${FACE_BIB_LINKING.KNN_RELAXED_DISTANCE}`);

    for (let index = 0; index < faces.length; index++) {
      const face = faces[index];
      this.logger.log(`      🔍 [KNN] Searching matches for face ${face.id} (embedding length: ${face.embedding?.length || 0})`);

      const matches = await this.faceKnnService.findMatches(
        eventId,
        face.embedding,
        FACE_BIB_LINKING.KNN_MAX_RESULTS
      );

      this.logger.log(`      📊 [KNN] Found ${matches.length} candidate(s) for face ${face.id}`);

      if (matches.length === 0) {
        this.logger.log(`      ❌ [KNN] No candidates in index for face ${face.id} - will try fallback`);
        remainingFaces.push(face);
        continue;
      }

      // Log all matches for debugging
      matches.forEach((m, i) => {
        this.logger.log(`         Match ${i}: bib="${m.bib}", distance=${m.distance.toFixed(4)}, confidence=${m.confidence.toFixed(3)}`);
      });

      const best = matches[0];
      this.logger.log(
        `      ✅ [KNN] Face ${face.id} best match "${best.bib}" ` +
        `(distance=${best.distance.toFixed(4)}, confidence=${best.confidence.toFixed(3)})`
      );

      if (best.distance <= FACE_BIB_LINKING.KNN_STRICT_DISTANCE) {
        const inferred = await this.upsertInferredBib({
          photoId,
          eventId,
          faceEmbeddingId: face.id,
          bib: best.bib,
          confidence: best.confidence,
          distance: best.distance,
          inferredFrom: `KNN:${best.sourceFaceEmbeddingId}`,
          verified: true,
        });

        await this.autoVerifyInferredBib(
          {
            inferredId: inferred.id,
            photoId,
            eventId,
            bib: best.bib,
            faceEmbeddingId: face.id,
            confidence: best.confidence,
            distance: best.distance,
          },
          'AUTO_KNN'
        );

        inferredCount++;
        continue;
      }

      if (best.distance <= FACE_BIB_LINKING.KNN_RELAXED_DISTANCE) {
        await this.upsertInferredBib({
          photoId,
          eventId,
          faceEmbeddingId: face.id,
          bib: best.bib,
          confidence: best.confidence,
          distance: best.distance,
          inferredFrom: `KNN:${best.sourceFaceEmbeddingId}`,
          verified: false,
        });

        this.logger.log(
          `      📌 [KNN] Pending verification for face ${face.id} → bib "${best.bib}" ` +
          `(confidence=${best.confidence.toFixed(3)})`
        );

        inferredCount++;
        continue;
      }

      this.logger.log(
        `      ⚠️ [KNN] Face ${face.id} best distance ${best.distance.toFixed(4)} ` +
        `exceeds relaxed threshold (${FACE_BIB_LINKING.KNN_RELAXED_DISTANCE})`
      );
      remainingFaces.push(face);
    }

    return { inferredCount, remainingFaces };
  }

  private async applySignatureFallback(
    eventId: string,
    photoId: string,
    faces: Array<Prisma.FaceEmbeddingGetPayload<{ select: { id: true; embedding: true } }>>
  ): Promise<number> {
    this.logger.log(
      `   🔁 Falling back to legacy signatures for ${faces.length} face(s)`
    );
    this.logger.log(`   📋 Signature thresholds: MIN_SAMPLES=${FACE_BIB_LINKING.MIN_SIGNATURE_SAMPLES}, MIN_CONFIDENCE=${FACE_BIB_LINKING.MIN_SIGNATURE_CONFIDENCE}, INFERENCE_THRESHOLD=${FACE_BIB_LINKING.INFERENCE_THRESHOLD}`);

    const allSignatures = await this.prisma.athleteSignature.findMany({
      where: { eventId },
    });

    this.logger.log(`   📊 Total signatures in event: ${allSignatures.length}`);

    // Log all signatures for debugging
    allSignatures.forEach((sig, i) => {
      this.logger.log(`      Signature ${i}: bib="${sig.bib}", samples=${sig.sampleCount}, confidence=${Number(sig.confidence).toFixed(3)}, embeddingLength=${sig.faceSignature?.length || 0}`);
    });

    const signatures = this.athleteSignatureService.filterReliableSignatures(allSignatures);

    this.logger.log(
      `   🎯 Reliable signatures after filtering: ${signatures.length}/${allSignatures.length}`
    );

    if (signatures.length === 0) {
      this.logger.log(`   ⚠️  No reliable signatures meet criteria - fallback skipped`);
      return 0;
    }

    let inferredCount = 0;

    for (let index = 0; index < faces.length; index++) {
      const face = faces[index];
      this.logger.log(
        `   🎭 [FALLBACK FACE ${index + 1}/${faces.length}] Comparing face ${face.id} against signatures`
      );

      let bestMatch = {
        bib: null as string | null,
        distance: 999,
        confidence: 0,
        signatureId: null as string | null,
      };

      this.logger.log(`      🔍 Comparing against ${signatures.length} signature(s)...`);

      for (const signature of signatures) {
        const distance = this.pythonFaceApiService.calculateDistance(
          face.embedding,
          signature.faceSignature
        );

        this.logger.log(`         vs bib="${signature.bib}": distance=${distance.toFixed(4)} (threshold=${FACE_BIB_LINKING.INFERENCE_THRESHOLD})`);

        if (
          distance < FACE_BIB_LINKING.INFERENCE_THRESHOLD &&
          distance < bestMatch.distance
        ) {
          bestMatch = {
            bib: signature.bib,
            distance,
            confidence: 1 - distance,
            signatureId: signature.id,
          };
          this.logger.log(`         🎯 New best match: bib="${signature.bib}"`);
        }
      }

      if (!bestMatch.bib || !bestMatch.signatureId) {
        this.logger.log(
          `      ❌ No signature match for face ${face.id} - best distance ${bestMatch.distance.toFixed(4)} > threshold ${FACE_BIB_LINKING.INFERENCE_THRESHOLD}`
        );
        continue;
      }

      this.logger.log(
        `      ✅ Best signature match bib "${bestMatch.bib}" (distance=${bestMatch.distance.toFixed(4)}, confidence=${bestMatch.confidence.toFixed(3)})`
      );

      const inferred = await this.upsertInferredBib({
        photoId,
        eventId,
        faceEmbeddingId: face.id,
        bib: bestMatch.bib,
        confidence: bestMatch.confidence,
        distance: bestMatch.distance,
        inferredFrom: bestMatch.signatureId,
        verified: false,
      });

      inferredCount++;

      if (bestMatch.confidence >= FACE_BIB_LINKING.AUTO_VERIFY_CONFIDENCE) {
        try {
          await this.autoVerifyInferredBib({
            inferredId: inferred.id,
            photoId,
            eventId,
            bib: bestMatch.bib,
            faceEmbeddingId: face.id,
            confidence: bestMatch.confidence,
            distance: bestMatch.distance,
          });
        } catch (autoError) {
          const errorMessage =
            autoError instanceof Error ? autoError.message : 'Unknown error';
          this.logger.warn(
            `      ⚠️  Failed to auto-verify fallback match for face ${face.id}: ${errorMessage}`
          );
        }
      }

      if (bestMatch.confidence >= FACE_BIB_LINKING.MIN_INFERRED_CONFIDENCE) {
        await this.athleteSignatureService.updateAthleteSignature(
          eventId,
          bestMatch.bib,
          face.embedding,
          undefined
        );
      }
    }

    return inferredCount;
  }

  private async upsertInferredBib(params: {
    photoId: string;
    eventId: string;
    faceEmbeddingId: string;
    bib: string;
    confidence: number;
    distance: number;
    inferredFrom: string | null;
    verified: boolean;
  }) {
    const {
      photoId,
      eventId,
      faceEmbeddingId,
      bib,
      confidence,
      distance,
      inferredFrom,
      verified,
    } = params;

    const record = await this.prisma.inferredBib.upsert({
      where: {
        faceEmbeddingId_bib: {
          faceEmbeddingId,
          bib,
        },
      },
      update: {
        confidence,
        faceDistance: distance,
        inferredFrom: inferredFrom ?? undefined,
        ...(verified ? { verified: true } : {}),
        rejected: false,
      },
      create: {
        photoId,
        faceEmbeddingId,
        eventId,
        bib,
        confidence,
        faceDistance: distance,
        inferredFrom: inferredFrom ?? undefined,
        verified,
        rejected: false,
      },
    });

    return record;
  }

  private async autoVerifyInferredBib(
    params: {
      inferredId?: string;
      photoId: string;
      eventId: string;
      bib: string;
      faceEmbeddingId: string;
      confidence: number;
      distance: number;
    },
    associationMethod: string = 'INFERRED'
  ): Promise<void> {
    const {
      inferredId,
      photoId,
      eventId,
      bib,
      faceEmbeddingId,
      confidence,
      distance
    } = params;

    if (!inferredId) {
      return;
    }

    this.logger.log(
      `      🤖 Auto-verifying inferred bib "${bib}" for photo ${photoId} (confidence=${confidence.toFixed(3)})`
    );

    await this.prisma.$transaction(async tx => {
      await tx.inferredBib.update({
        where: { id: inferredId },
        data: {
          verified: true,
          rejected: false
        }
      });

      let photoBib = await tx.photoBib.findFirst({
        where: {
          photoId,
          bib
        }
      });

      if (!photoBib) {
        photoBib = await tx.photoBib.create({
          data: {
            photoId,
            eventId,
            bib,
            confidence,
            source: 'FACE_INFERRED'
          }
        });

        this.logger.log(
          `         ➕ Created auto-verified photo_bib (${photoBib.id.toString()}) for bib "${bib}"`
        );
      } else if (Number(photoBib.confidence) < confidence) {
        photoBib = await tx.photoBib.update({
          where: { id: photoBib.id },
          data: {
            confidence,
            source: photoBib.source || 'FACE_INFERRED'
          }
        });

        this.logger.log(
          `         🔁 Updated photo_bib ${photoBib.id.toString()} confidence -> ${confidence.toFixed(3)}`
        );
      }

      const association = await tx.faceBibAssociation.findFirst({
        where: {
          faceEmbeddingId,
          photoBibId: photoBib.id
        }
      });

      const associationScore = Math.max(0, Math.min(1, 1 - distance));

      if (!association) {
        await tx.faceBibAssociation.create({
          data: {
            faceEmbeddingId,
            photoBibId: photoBib.id,
            photoId,
            eventId,
            bib,
            spatialScore: associationScore,
            method: associationMethod
          }
        });

        this.logger.log(
          `         🔗 Linked face ${faceEmbeddingId} with bib "${bib}" (auto score=${associationScore.toFixed(3)})`
        );
      }
    });

    this.faceKnnService.invalidate(eventId);
  }
}
