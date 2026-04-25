import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/services/prisma.service';
import { FACE_BIB_LINKING } from '@shared/constants';

export interface ResolvedPhoto {
  photoId: string;
  thumbUrl: string;
  watermarkUrl: string;
  originalUrl: string;
  takenAt: string;
  confidence: number;
  /**
   * FACE_DIRECT   – face similarity matched directly by embedding comparison
   * BIB_VIA_FACE  – athlete's bib was confirmed in another photo; this photo has that bib (no face needed)
   * INFERRED_VIA_FACE – bib was inferred (not confirmed) for this photo, found via face link
   */
  discoveryType: 'FACE_DIRECT' | 'BIB_VIA_FACE' | 'INFERRED_VIA_FACE';
  faceBbox?: [number, number, number, number];
  detectedBibs?: string[];
}

export interface AthletePortfolio {
  photos: ResolvedPhoto[];
  confirmedBibs: string[];
  inferredBibs: string[];
}

/**
 * IdentityResolverService
 *
 * Core of the bidirectional face↔bib identity graph.
 *
 * Given a set of face matches (from a selfie search), this service:
 *   1. Finds all confirmed bibs linked to those faces (FaceBibAssociation)
 *   2. Finds all high-confidence inferred bibs for those faces (InferredBib)
 *   3. Fetches ALL photos that carry any of those bibs (PhotoBib + InferredBib by bib)
 *   4. Returns the full athlete portfolio deduplicated and ranked
 *
 * Scale design: runs exactly 4 DB queries regardless of event size (10k+ photos).
 * All resolution is done with IN clauses — no N+1 patterns.
 */
@Injectable()
export class IdentityResolverService {
  private readonly logger = new Logger(IdentityResolverService.name);

  constructor(private readonly prisma: PrismaService) {}

  async resolveAthletePortfolio(
    eventId: string,
    matchedFaceIds: string[],
    /** Photos already found by direct face match (so we can tag them FACE_DIRECT) */
    directFacePhotoIds: Set<string>,
  ): Promise<AthletePortfolio> {
    if (matchedFaceIds.length === 0) {
      return { photos: [], confirmedBibs: [], inferredBibs: [] };
    }

    this.logger.log(
      `[IdentityResolver] Resolving portfolio for ${matchedFaceIds.length} face(s) in event ${eventId}`,
    );

    // ── Query 1: confirmed bibs for matched faces (spatial / KNN / manual) ──
    // ── Query 2: inferred bibs for matched faces (high-confidence only)    ──
    // Run both in parallel — independent queries.
    const [confirmedAssociations, inferredAssociations] = await Promise.all([
      this.prisma.faceBibAssociation.findMany({
        where: {
          eventId,
          faceEmbeddingId: { in: matchedFaceIds },
        },
        select: {
          bib: true,
          spatialScore: true,
          method: true,
        },
      }),
      this.prisma.inferredBib.findMany({
        where: {
          eventId,
          faceEmbeddingId: { in: matchedFaceIds },
          rejected: false,
          confidence: { gte: FACE_BIB_LINKING.MIN_INFERRED_CONFIDENCE },
        },
        select: {
          bib: true,
          confidence: true,
          verified: true,
        },
      }),
    ]);

    // Collect unique bibs from confirmed and inferred associations
    const confirmedBibs = [
      ...new Set(confirmedAssociations.map((a) => a.bib)),
    ];
    const inferredBibSet = new Set(inferredAssociations.map((a) => a.bib));
    // Remove bibs already confirmed (they should be treated as confirmed)
    const confirmedBibSet = new Set(confirmedBibs);
    const inferredOnlyBibs = [...inferredBibSet].filter(
      (b) => !confirmedBibSet.has(b),
    );

    const allBibs = [...confirmedBibs, ...inferredOnlyBibs];

    if (allBibs.length === 0) {
      this.logger.log(
        `[IdentityResolver] No bibs found for matched faces — portfolio is face-only`,
      );
      return { photos: [], confirmedBibs: [], inferredBibs: inferredOnlyBibs };
    }

    this.logger.log(
      `[IdentityResolver] Bibs resolved — confirmed: [${confirmedBibs.join(', ')}] ` +
        `inferred: [${inferredOnlyBibs.join(', ')}]`,
    );

    // ── Query 3: all photos with those bibs (detected by Gemini or auto-verified) ──
    // ── Query 4: all inferred photos for those bibs (face-inferred, not direct bib) ──
    // Run both in parallel.
    const [bibPhotos, inferredBibPhotos] = await Promise.all([
      this.prisma.photoBib.findMany({
        where: {
          eventId,
          bib: { in: allBibs },
          photo: {
            status: 'PROCESSED',
            watermarkUrl: { not: null },
            thumbUrl: { not: null },
          },
        },
        select: {
          bib: true,
          confidence: true,
          photo: {
            select: {
              id: true,
              thumbUrl: true,
              watermarkUrl: true,
              originalUrl: true,
              takenAt: true,
              createdAt: true,
            },
          },
        },
      }),
      this.prisma.inferredBib.findMany({
        where: {
          eventId,
          bib: { in: allBibs },
          rejected: false,
          confidence: { gte: FACE_BIB_LINKING.MIN_INFERRED_CONFIDENCE },
          // Exclude already-verified ones — they show up in PhotoBib via autoVerify
          verified: false,
          photo: {
            status: 'PROCESSED',
            watermarkUrl: { not: null },
            thumbUrl: { not: null },
          },
        },
        select: {
          bib: true,
          confidence: true,
          faceEmbedding: { select: { bbox: true } },
          photo: {
            select: {
              id: true,
              thumbUrl: true,
              watermarkUrl: true,
              originalUrl: true,
              takenAt: true,
              createdAt: true,
            },
          },
        },
      }),
    ]);

    this.logger.log(
      `[IdentityResolver] Bib photos found — direct: ${bibPhotos.length}, inferred: ${inferredBibPhotos.length}`,
    );

    // ── Merge and deduplicate ──
    // Priority: FACE_DIRECT > BIB_VIA_FACE > INFERRED_VIA_FACE
    const photoMap = new Map<string, ResolvedPhoto>();

    const addOrKeepBest = (candidate: ResolvedPhoto) => {
      const existing = photoMap.get(candidate.photoId);
      if (!existing) {
        photoMap.set(candidate.photoId, candidate);
        return;
      }
      // Prefer higher priority discovery type
      const priority: Record<ResolvedPhoto['discoveryType'], number> = {
        FACE_DIRECT: 3,
        BIB_VIA_FACE: 2,
        INFERRED_VIA_FACE: 1,
      };
      if (
        priority[candidate.discoveryType] > priority[existing.discoveryType] ||
        (priority[candidate.discoveryType] === priority[existing.discoveryType] &&
          candidate.confidence > existing.confidence)
      ) {
        photoMap.set(candidate.photoId, candidate);
      }
    };

    // Bib-confirmed photos (BIB_VIA_FACE)
    for (const bp of bibPhotos) {
      const p = bp.photo;
      const photoId = p.id;
      const isAlreadyDirect = directFacePhotoIds.has(photoId);
      addOrKeepBest({
        photoId,
        thumbUrl: p.thumbUrl!,
        watermarkUrl: p.watermarkUrl!,
        originalUrl: p.originalUrl!,
        takenAt: p.takenAt?.toISOString() ?? p.createdAt.toISOString(),
        confidence: Number(bp.confidence),
        discoveryType: isAlreadyDirect ? 'FACE_DIRECT' : 'BIB_VIA_FACE',
        detectedBibs: [bp.bib],
      });
    }

    // Inferred bib photos (INFERRED_VIA_FACE)
    for (const ib of inferredBibPhotos) {
      const p = ib.photo;
      const photoId = p.id;
      const isAlreadyDirect = directFacePhotoIds.has(photoId);
      const isAlreadyBib = photoMap.has(photoId);
      addOrKeepBest({
        photoId,
        thumbUrl: p.thumbUrl!,
        watermarkUrl: p.watermarkUrl!,
        originalUrl: p.originalUrl!,
        takenAt: p.takenAt?.toISOString() ?? p.createdAt.toISOString(),
        confidence: Number(ib.confidence),
        discoveryType: isAlreadyDirect
          ? 'FACE_DIRECT'
          : isAlreadyBib
            ? 'BIB_VIA_FACE'
            : 'INFERRED_VIA_FACE',
        faceBbox: ib.faceEmbedding?.bbox as [number, number, number, number] | undefined,
        detectedBibs: [ib.bib],
      });
    }

    const photos = [...photoMap.values()].sort((a, b) => {
      const priority: Record<ResolvedPhoto['discoveryType'], number> = {
        FACE_DIRECT: 3,
        BIB_VIA_FACE: 2,
        INFERRED_VIA_FACE: 1,
      };
      const pd = priority[b.discoveryType] - priority[a.discoveryType];
      if (pd !== 0) return pd;
      return b.confidence - a.confidence;
    });

    this.logger.log(
      `[IdentityResolver] Portfolio complete — ${photos.length} total photos ` +
        `(${photos.filter((p) => p.discoveryType === 'FACE_DIRECT').length} face-direct, ` +
        `${photos.filter((p) => p.discoveryType === 'BIB_VIA_FACE').length} bib-via-face, ` +
        `${photos.filter((p) => p.discoveryType === 'INFERRED_VIA_FACE').length} inferred-via-face)`,
    );

    return {
      photos,
      confirmedBibs,
      inferredBibs: inferredOnlyBibs,
    };
  }
}
