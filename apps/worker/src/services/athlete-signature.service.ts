import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../api/src/common/services/prisma.service';
import { AthleteSignature } from '@prisma/client';
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
    this.logger.log(
      `🎭 [SIGNATURE-UPDATE] Bib "${bib}" - geminiConfidence: ${geminiConfidence !== undefined ? geminiConfidence.toFixed(3) : 'undefined (bypassed)'}`
    );

    // Only use high-confidence Gemini detections for building signatures
    if (
      geminiConfidence !== undefined &&
      geminiConfidence < FACE_BIB_LINKING.MIN_GEMINI_CONFIDENCE
    ) {
      this.logger.warn(
        `   ❌ REJECTED: Gemini confidence ${geminiConfidence.toFixed(3)} < ${FACE_BIB_LINKING.MIN_GEMINI_CONFIDENCE} threshold`
      );
      return;
    }

    this.logger.log(`   ✅ Confidence check passed - proceeding with signature update`);

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

        if (currentSignature.length !== newEmbedding.length) {
          this.logger.warn(
            `   ⚠️ Dimension mismatch for bib "${bib}" signature (${currentSignature.length} vs ${newEmbedding.length}) - resetting signature with fresh embedding`
          );

          await this.prisma.athleteSignature.update({
            where: { id: existing.id },
            data: {
              faceSignature: this.toUnitVector(newEmbedding),
              sampleCount: 1,
              confidence: FACE_BIB_LINKING.SIGNATURE_CONFIDENCE_START,
              updatedAt: new Date()
            }
          });

          this.logger.log(
            `   🔄 Signature for bib "${bib}" reset to new embedding (sampleCount=1, confidence=${FACE_BIB_LINKING.SIGNATURE_CONFIDENCE_START.toFixed(3)})`
          );
          return;
        }

        // Media móvil exponencial sobre vectores normalizados.
        //
        // InsightFace devuelve el embedding sin normalizar, y su norma varía
        // mucho según el tamaño y la calidad de la cara. Promediando en crudo,
        // los primeros planos dominaban la firma y las caras lejanas del mismo
        // atleta apenas contaban. Normalizando, cada muestra pesa igual.
        const previous = this.toUnitVector(currentSignature);
        const incoming = this.toUnitVector(newEmbedding);
        const updatedSignature = previous.map((val, idx) =>
          val * (1 - alpha) + incoming[idx] * alpha
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
          `   💾 UPDATED signature for bib "${bib}" ` +
          `(samples: ${currentCount} → ${currentCount + 1}, confidence: ${Number(existing.confidence).toFixed(3)} → ${newConfidence.toFixed(3)})`
        );

      } else {
        // ═══════════════════════════════════════════════════
        // CREATE NEW SIGNATURE
        // ═══════════════════════════════════════════════════

        await this.prisma.athleteSignature.create({
          data: {
            eventId,
            bib,
            faceSignature: this.toUnitVector(newEmbedding),
            sampleCount: 1,
            confidence: FACE_BIB_LINKING.SIGNATURE_CONFIDENCE_START
          }
        });

        this.logger.log(
          `   🆕 CREATED NEW signature for bib "${bib}" ` +
          `(samples: 1, confidence: ${FACE_BIB_LINKING.SIGNATURE_CONFIDENCE_START.toFixed(3)})`
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
   * Lleva un embedding a norma 1. La comparación por coseno es invariante a la
   * escala, pero promediar no lo es: sin esto, la magnitud decide qué muestras
   * pesan más en la firma.
   */
  private toUnitVector(values: number[]): number[] {
    let norm = 0;
    for (const value of values) norm += value * value;
    if (!Number.isFinite(norm) || norm === 0) return values;
    const inv = 1 / Math.sqrt(norm);
    return values.map(value => value * inv);
  }

  /**
   * Determine if a signature is reliable enough to be used for inference
   */
  public isSignatureReliable(signature: Pick<AthleteSignature, 'sampleCount' | 'confidence'>): boolean {
    if (signature.sampleCount >= FACE_BIB_LINKING.MIN_SIGNATURE_SAMPLES) {
      return true;
    }
    const confidenceValue = Number(signature.confidence ?? 0);
    return confidenceValue >= FACE_BIB_LINKING.MIN_SIGNATURE_CONFIDENCE;
  }

  /**
   * Filter signatures down to only those considered reliable
   */
  public filterReliableSignatures<T extends { sampleCount: number; confidence: any }>(
    signatures: T[]
  ): T[] {
    return signatures.filter(signature => this.isSignatureReliable(signature));
  }

  /**
   * Get all reliable athlete signatures for an event
   * Only returns signatures trustworthy enough for inference
   */
  async getReliableSignatures(eventId: string) {
    const signatures = await this.prisma.athleteSignature.findMany({
      where: { eventId },
      orderBy: {
        confidence: 'desc'
      }
    });

    return this.filterReliableSignatures(signatures);
  }

  /**
   * Get reliable signatures for a subset of bibs within an event
   */
  async getReliableSignaturesForBibs(eventId: string, bibs: string[]) {
    if (!bibs.length) {
      return [];
    }

    const signatures = await this.prisma.athleteSignature.findMany({
      where: {
        eventId,
        bib: {
          in: bibs
        }
      },
      orderBy: {
        confidence: 'desc'
      }
    });

    return this.filterReliableSignatures(signatures);
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

    const reliableSignatures = this.filterReliableSignatures(allSignatures);

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
        faceSignature: this.toUnitVector(newEmbedding),
        sampleCount: 1,
        confidence: FACE_BIB_LINKING.SIGNATURE_CONFIDENCE_START
      },
      update: {
        faceSignature: this.toUnitVector(newEmbedding),
        sampleCount: 1,
        confidence: FACE_BIB_LINKING.SIGNATURE_CONFIDENCE_START,
        updatedAt: new Date()
      }
    });

    this.logger.log(`Reset signature for bib ${bib}`);
  }
}
