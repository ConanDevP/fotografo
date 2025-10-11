import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/services/prisma.service';
import { InferredBibReview } from '@shared/types';

@Injectable()
export class AdminInferredBibsService {
  private readonly logger = new Logger(AdminInferredBibsService.name);

  constructor(private prisma: PrismaService) {}

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
            embedding: true
          }
        }
      }
    });

    if (!inferred) {
      throw new NotFoundException('Inferred bib not found');
    }

    // Mark as verified
    await this.prisma.inferredBib.update({
      where: { id: inferredBibId },
      data: {
        verified: true,
        rejected: false
      }
    });

    // Update athlete signature with this verified match
    // This improves future inferences
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
    const result = await this.prisma.inferredBib.updateMany({
      where: {
        id: { in: inferredBibIds }
      },
      data: {
        verified: true,
        rejected: false
      }
    });

    this.logger.log(`✅ Bulk verified ${result.count} inferred bibs`);

    return { verified: result.count };
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
