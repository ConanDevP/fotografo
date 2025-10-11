import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../api/src/common/services/prisma.service';
import { FACE_BIB_LINKING } from '@shared/constants';

@Injectable()
export class AthleteSignatureService {
  private readonly logger = new Logger(AthleteSignatureService.name);

  constructor(private prisma: PrismaService) {}

  /**
   * Update or create athlete signature (face embedding average for a bib)
   *
   * Uses Exponential Moving Average (EMA) to update the signature
   * This gives more weight to recent faces while maintaining stability
   *
   * @param eventId Event ID
   * @param bib Bib number
   * @param newEmbedding New face embedding to incorporate
   * @param geminiConfidence Confidence of the Gemini bib detection (optional filter)
   */
  async updateAthleteSignature(
    eventId: string,
    bib: string,
    newEmbedding: number[],
    geminiConfidence?: number
  ): Promise<void> {
    // Only use high-confidence Gemini detections for building signatures
    if (
      geminiConfidence !== undefined &&
      geminiConfidence < FACE_BIB_LINKING.MIN_GEMINI_CONFIDENCE
    ) {
      this.logger.debug(
        `Skipping signature update for bib ${bib} - ` +
        `Gemini confidence ${geminiConfidence.toFixed(3)} < ${FACE_BIB_LINKING.MIN_GEMINI_CONFIDENCE}`
      );
      return;
    }

    try {
      const existing = await this.prisma.athleteSignature.findUnique({
        where: {
          eventId_bib: { eventId, bib }
        }
      });

      if (existing) {
        // ═══════════════════════════════════════════════════
        // UPDATE EXISTING SIGNATURE
        // ═══════════════════════════════════════════════════

        const currentSignature = existing.faceSignature;
        const currentCount = existing.sampleCount;
        const alpha = FACE_BIB_LINKING.SIGNATURE_EMA_ALPHA;

        // Exponential Moving Average (EMA)
        // new_signature = (1 - alpha) * old_signature + alpha * new_embedding
        const updatedSignature = currentSignature.map((val, idx) =>
          val * (1 - alpha) + newEmbedding[idx] * alpha
        );

        // Increase confidence with more samples (cap at 0.99)
        const newConfidence = Math.min(
          0.99,
          Number(existing.confidence) + FACE_BIB_LINKING.SIGNATURE_CONFIDENCE_INCREMENT
        );

        await this.prisma.athleteSignature.update({
          where: { id: existing.id },
          data: {
            faceSignature: updatedSignature,
            sampleCount: { increment: 1 },
            confidence: newConfidence,
            updatedAt: new Date()
          }
        });

        this.logger.log(
          `✅ Updated signature for bib ${bib} ` +
          `(${currentCount + 1} samples, confidence: ${newConfidence.toFixed(3)})`
        );

      } else {
        // ═══════════════════════════════════════════════════
        // CREATE NEW SIGNATURE
        // ═══════════════════════════════════════════════════

        await this.prisma.athleteSignature.create({
          data: {
            eventId,
            bib,
            faceSignature: newEmbedding,
            sampleCount: 1,
            confidence: FACE_BIB_LINKING.SIGNATURE_CONFIDENCE_START
          }
        });

        this.logger.log(
          `🆕 Created signature for bib ${bib} ` +
          `(confidence: ${FACE_BIB_LINKING.SIGNATURE_CONFIDENCE_START.toFixed(3)})`
        );
      }

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(
        `Error updating athlete signature for bib ${bib}: ${errorMessage}`
      );
      // Don't throw - signature updates shouldn't fail the main job
    }
  }

  /**
   * Get all reliable athlete signatures for an event
   * Only returns signatures with enough samples to be trustworthy
   */
  async getReliableSignatures(eventId: string) {
    return await this.prisma.athleteSignature.findMany({
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
  }

  /**
   * Get signature for a specific bib
   */
  async getSignatureForBib(eventId: string, bib: string) {
    return await this.prisma.athleteSignature.findUnique({
      where: {
        eventId_bib: { eventId, bib }
      }
    });
  }

  /**
   * Get statistics about signatures in an event
   */
  async getSignatureStats(eventId: string) {
    const allSignatures = await this.prisma.athleteSignature.findMany({
      where: { eventId },
      select: {
        bib: true,
        sampleCount: true,
        confidence: true
      }
    });

    const reliableSignatures = allSignatures.filter(
      s => s.sampleCount >= FACE_BIB_LINKING.MIN_SIGNATURE_SAMPLES
    );

    const avgSampleCount = allSignatures.length > 0
      ? allSignatures.reduce((sum, s) => sum + s.sampleCount, 0) / allSignatures.length
      : 0;

    const avgConfidence = allSignatures.length > 0
      ? allSignatures.reduce((sum, s) => sum + Number(s.confidence), 0) / allSignatures.length
      : 0;

    return {
      totalSignatures: allSignatures.length,
      reliableSignatures: reliableSignatures.length,
      averageSampleCount: Number(avgSampleCount.toFixed(2)),
      averageConfidence: Number(avgConfidence.toFixed(3))
    };
  }

  /**
   * Delete signature (useful for incorrect associations)
   */
  async deleteSignature(eventId: string, bib: string): Promise<boolean> {
    try {
      await this.prisma.athleteSignature.delete({
        where: {
          eventId_bib: { eventId, bib }
        }
      });
      this.logger.log(`Deleted signature for bib ${bib}`);
      return true;
    } catch (error) {
      this.logger.error(`Failed to delete signature for bib ${bib}`);
      return false;
    }
  }

  /**
   * Reset signature (start fresh with new sample)
   */
  async resetSignature(
    eventId: string,
    bib: string,
    newEmbedding: number[]
  ): Promise<void> {
    await this.prisma.athleteSignature.upsert({
      where: {
        eventId_bib: { eventId, bib }
      },
      create: {
        eventId,
        bib,
        faceSignature: newEmbedding,
        sampleCount: 1,
        confidence: FACE_BIB_LINKING.SIGNATURE_CONFIDENCE_START
      },
      update: {
        faceSignature: newEmbedding,
        sampleCount: 1,
        confidence: FACE_BIB_LINKING.SIGNATURE_CONFIDENCE_START,
        updatedAt: new Date()
      }
    });

    this.logger.log(`Reset signature for bib ${bib}`);
  }
}
