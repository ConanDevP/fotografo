import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/services/prisma.service';
import { InferredBibReview } from '@shared/types';
import { Prisma, PhotoBib } from '@prisma/client';

type InferredBibWithEmbedding = Prisma.InferredBibGetPayload<{
  include: {
    faceEmbedding: {
      select: {
        embedding: true;
        bbox: true;
      };
    };
  };
}>;

@Injectable()
export class AdminInferredBibsService {
  private readonly logger = new Logger(AdminInferredBibsService.name);

  constructor(private prisma: PrismaService) {}

  /**
   * Ensure the inferred bib is persisted as a real photo_bib and linked to the face embedding
   */
  private async assignInferredBibToPhoto(inferred: InferredBibWithEmbedding): Promise<void> {
    if (!inferred.faceEmbedding) {
      this.logger.warn(`Inferred bib ${inferred.id} has no face embedding linked; skipping assignment`);
      return;
    }

    const existingPhotoBib = await this.prisma.photoBib.findFirst({
      where: {
        photoId: inferred.photoId,
        bib: inferred.bib,
      },
    });

    const newConfidence = Number(inferred.confidence ?? 0);
    let targetPhotoBib: PhotoBib;

    if (!existingPhotoBib) {
      targetPhotoBib = await this.prisma.photoBib.create({
        data: {
          photoId: inferred.photoId,
          eventId: inferred.eventId,
          bib: inferred.bib,
          confidence: inferred.confidence,
          source: 'FACE_INFERRED',
          bbox: null,
        },
      });

      this.logger.log(
        `   ➕ Created FACE_INFERRED photo_bib for photo ${inferred.photoId} ↔ bib "${inferred.bib}" (confidence: ${newConfidence.toFixed(3)})`,
      );
    } else {
      targetPhotoBib = existingPhotoBib;
      const existingConfidence = Number(existingPhotoBib.confidence ?? 0);

      if (newConfidence > existingConfidence) {
        targetPhotoBib = await this.prisma.photoBib.update({
          where: { id: existingPhotoBib.id },
          data: {
            confidence: inferred.confidence,
            source: existingPhotoBib.source || 'FACE_INFERRED',
          },
        });

        this.logger.log(
          `   🔁 Updated photo_bib ${existingPhotoBib.id.toString()} confidence ${existingConfidence.toFixed(
            3,
          )} → ${newConfidence.toFixed(3)}`,
        );
      }
    }

    const existingAssociation = await this.prisma.faceBibAssociation.findFirst({
      where: {
        faceEmbeddingId: inferred.faceEmbeddingId,
        photoBibId: targetPhotoBib.id,
      },
    });

    if (!existingAssociation) {
      const distance = Number(inferred.faceDistance ?? 1);
      const associationScore = Math.max(0, Math.min(1, 1 - distance));

      await this.prisma.faceBibAssociation.create({
        data: {
          faceEmbeddingId: inferred.faceEmbeddingId,
          photoBibId: targetPhotoBib.id,
          photoId: inferred.photoId,
          eventId: inferred.eventId,
          bib: inferred.bib,
          spatialScore: associationScore,
          method: 'INFERRED',
        },
      });

      this.logger.log(
        `   🔗 Linked face ${inferred.faceEmbeddingId} with bib "${inferred.bib}" (score: ${associationScore.toFixed(3)})`,
      );
    }
  }

  /**
   * Get inferred bibs for review by photographer
   */
  async getInferredBibsForReview(
    eventId: string,
    status: 'pending' | 'verified' | 'rejected' | 'all' = 'pending',
    limit = 100,
    offset = 0
  ): Promise<{ items: InferredBibReview[]; total: number }> {
    // Build where clause based on status
    const where: any = { eventId };

    if (status === 'pending') {
      where.verified = false;
      where.rejected = false;
    } else if (status === 'verified') {
      where.verified = true;
    } else if (status === 'rejected') {
      where.rejected = true;
    }

    const [items, total] = await Promise.all([
      this.prisma.inferredBib.findMany({
        where,
        include: {
          photo: {
            select: {
              thumbUrl: true,
              watermarkUrl: true
            }
          },
          faceEmbedding: {
            select: {
              bbox: true
            }
          }
        },
        orderBy: { confidence: 'desc' },
        take: limit,
        skip: offset
      }),
      this.prisma.inferredBib.count({ where })
    ]);

    return {
      items: items.map(ib => ({
        id: ib.id,
        photoId: ib.photoId,
        thumbUrl: ib.photo.thumbUrl || '',
        bib: ib.bib,
        confidence: Number(ib.confidence),
        faceBbox: ib.faceEmbedding.bbox as [number, number, number, number],
        verified: ib.verified,
        rejected: ib.rejected
      })),
      total
    };
  }

  /**
   * Verify an inferred bib (photographer confirms it's correct)
   */
  async verifyInferredBib(inferredBibId: string): Promise<void> {
    const inferred = await this.prisma.inferredBib.findUnique({
      where: { id: inferredBibId },
      include: {
        faceEmbedding: {
          select: {
            embedding: true,
            bbox: true,
          }
        }
      }
    });

    if (!inferred) {
      throw new NotFoundException('Inferred bib not found');
    }

    const wasAlreadyVerified = inferred.verified && !inferred.rejected;

    if (!wasAlreadyVerified) {
      await this.prisma.inferredBib.update({
        where: { id: inferredBibId },
        data: {
          verified: true,
          rejected: false
        }
      });
      inferred.verified = true;
      inferred.rejected = false;
    } else {
      this.logger.log(`ℹ️ Inferred bib ${inferredBibId} was already verified; refreshing links`);
    }

    await this.assignInferredBibToPhoto(inferred);

    // Update athlete signature with this verified match
    // This improves future inferences
    if (!wasAlreadyVerified) {
      if (!inferred.faceEmbedding?.embedding) {
        this.logger.warn(
          `   ⚠️ Missing embedding data for inferred bib ${inferredBibId}; skipping signature update`
        );
      } else {
        const existing = await this.prisma.athleteSignature.findUnique({
          where: {
            eventId_bib: {
              eventId: inferred.eventId,
              bib: inferred.bib
          }
        }
      });

        if (existing) {
          // Update signature with verified embedding
          const alpha = 0.3;
          const updatedSignature = existing.faceSignature.map((val, idx) =>
            val * (1 - alpha) + inferred.faceEmbedding.embedding[idx] * alpha
          );

          await this.prisma.athleteSignature.update({
            where: { id: existing.id },
            data: {
              faceSignature: updatedSignature,
              sampleCount: { increment: 1 },
              confidence: Math.min(0.99, Number(existing.confidence) + 0.02)
            }
          });
        }
      }
    } else {
      this.logger.log(`   ↪️ Signature already reinforced previously; skipping EMA update`);
    }

    this.logger.log(`✅ Verified inferred bib ${inferredBibId} (bib: ${inferred.bib})`);
  }

  /**
   * Reject an inferred bib (photographer says it's wrong)
   */
  async rejectInferredBib(inferredBibId: string): Promise<void> {
    const inferred = await this.prisma.inferredBib.findUnique({
      where: { id: inferredBibId }
    });

    if (!inferred) {
      throw new NotFoundException('Inferred bib not found');
    }

    await this.prisma.inferredBib.update({
      where: { id: inferredBibId },
      data: {
        rejected: true,
        verified: false
      }
    });

    this.logger.log(`❌ Rejected inferred bib ${inferredBibId} (bib: ${inferred.bib})`);
  }

  /**
   * Bulk verify multiple inferred bibs
   */
  async bulkVerifyInferredBibs(inferredBibIds: string[]): Promise<{ verified: number }> {
    let verifiedCount = 0;

    for (const id of inferredBibIds) {
      try {
        await this.verifyInferredBib(id);
        verifiedCount++;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        this.logger.warn(
          `   ⚠️ Failed to verify inferred bib ${id}: ${errorMessage}`
        );
      }
    }

    this.logger.log(`✅ Bulk verified ${verifiedCount} inferred bibs (requested: ${inferredBibIds.length})`);

    return { verified: verifiedCount };
  }

  /**
   * Bulk reject multiple inferred bibs
   */
  async bulkRejectInferredBibs(inferredBibIds: string[]): Promise<{ rejected: number }> {
    const result = await this.prisma.inferredBib.updateMany({
      where: {
        id: { in: inferredBibIds }
      },
      data: {
        rejected: true,
        verified: false
      }
    });

    this.logger.log(`❌ Bulk rejected ${result.count} inferred bibs`);

    return { rejected: result.count };
  }

  /**
   * Get statistics about inferred bibs for an event
   */
  async getInferredBibsStats(eventId: string) {
    const [total, pending, verified, rejected] = await Promise.all([
      this.prisma.inferredBib.count({ where: { eventId } }),
      this.prisma.inferredBib.count({ where: { eventId, verified: false, rejected: false } }),
      this.prisma.inferredBib.count({ where: { eventId, verified: true } }),
      this.prisma.inferredBib.count({ where: { eventId, rejected: true } })
    ]);

    // Get average confidence
    const allInferred = await this.prisma.inferredBib.findMany({
      where: { eventId },
      select: { confidence: true }
    });

    const avgConfidence = allInferred.length > 0
      ? allInferred.reduce((sum, ib) => sum + Number(ib.confidence), 0) / allInferred.length
      : 0;

    return {
      total,
      pending,
      verified,
      rejected,
      averageConfidence: Number(avgConfidence.toFixed(3))
    };
  }
}
