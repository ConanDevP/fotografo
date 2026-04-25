import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../common/services/prisma.service';
import { StorageService } from '../common/services/storage.service';
import { PythonFaceApiService } from '../../../worker/src/services/python-face-api.service';
import { IdentityResolverService, ResolvedPhoto } from './identity-resolver.service';
import {
  FaceSearchRequest,
  FaceSearchResponse,
  FaceSearchResult,
  PhotoSearchResult,
} from '@shared/types';
import { FACE_RECOGNITION, ERROR_CODES } from '@shared/constants';
import { getErrorMessage } from '@shared/utils';

@Injectable()
export class FaceSearchService {
  private readonly logger = new Logger(FaceSearchService.name);

  constructor(
    private prisma: PrismaService,
    private storageService: StorageService,
    private pythonFaceApiService: PythonFaceApiService,
    private identityResolver: IdentityResolverService,
  ) {}

  async searchPhotosByFace(
    eventId: string,
    searchRequest: FaceSearchRequest,
  ): Promise<FaceSearchResponse> {
    const startTime = Date.now();

    try {
      // ── Verify event ──
      const event = await this.prisma.event.findUnique({
        where: { id: eventId },
        select: { id: true, name: true },
      });
      if (!event) {
        throw new NotFoundException({
          code: ERROR_CODES.EVENT_NOT_FOUND,
          message: 'Event not found',
        });
      }

      if (!this.pythonFaceApiService.isReadySync()) {
        throw new BadRequestException({
          code: ERROR_CODES.INTERNAL_ERROR,
          message: 'Face recognition service is not available',
        });
      }

      // ── Step 1: Extract face embedding from uploaded selfie ──
      this.logger.log(`Extracting face from user image for event ${eventId}`);

      const base64Data = searchRequest.userImageBase64.split(',').pop() || '';
      const imageBuffer = Buffer.from(base64Data, 'base64');

      const tempImageKey = `temp/search/${Date.now()}-${Math.random().toString(36).substring(7)}.jpg`;
      await this.storageService.uploadImage(imageBuffer, tempImageKey);
      const tempImageUrl = await this.storageService.generateSecureDownloadUrl(tempImageKey, 900);

      let userFaceDescriptor: Float32Array | null = null;

      try {
        const faces = await this.pythonFaceApiService.detectAllFaces(tempImageUrl, 1);
        if (faces.length > 0) {
          userFaceDescriptor = new Float32Array(faces[0].embedding);
          this.logger.log(`Face extracted. Confidence: ${faces[0].confidence}`);
        } else {
          this.logger.warn('No face detected in search image');
        }
      } finally {
        try {
          await this.storageService.deleteImage(tempImageKey);
        } catch (cleanupError) {
          this.logger.warn(`Failed to cleanup temp image ${tempImageKey}:`, cleanupError);
        }
      }

      if (!userFaceDescriptor) {
        return {
          matches: [],
          total: 0,
          searchTime: Date.now() - startTime,
          userFaceDetected: false,
        };
      }

      // ── Step 2: Load all face embeddings for this event ──
      // We load them all at once and do in-memory distance calculation.
      // At 10k photos × ~1.5 faces = ~15k embeddings, each 512 floats × 4 bytes = ~30MB.
      // This is intentional — Redis KNN is used for inference (worker side);
      // for search latency we want a single DB round-trip.
      const eventFaces = await this.prisma.faceEmbedding.findMany({
        where: { eventId },
        select: {
          id: true,
          embedding: true,
          confidence: true,
          bbox: true,
          photoId: true,
          photo: {
            select: {
              id: true,
              thumbUrl: true,
              watermarkUrl: true,
              originalUrl: true,
              takenAt: true,
              createdAt: true,
              status: true,
            },
          },
        },
      });

      this.logger.log(`Comparing selfie against ${eventFaces.length} face embeddings`);

      if (eventFaces.length === 0) {
        return {
          matches: [],
          total: 0,
          searchTime: Date.now() - startTime,
          userFaceDetected: true,
        };
      }

      // ── Step 3: Distance comparison ──
      const threshold = searchRequest.threshold ?? FACE_RECOGNITION.DEFAULT_THRESHOLD;
      const userDescriptor = Array.from(userFaceDescriptor);

      // directMatches: photos where the face is directly visible and similar
      const directMatchMap = new Map<
        string,
        { faceId: string; similarity: number; confidence: number; bbox: any; photo: (typeof eventFaces)[0]['photo'] }
      >();

      for (const ef of eventFaces) {
        if (ef.photo.status !== 'PROCESSED') continue;

        const distance = this.pythonFaceApiService.calculateDistance(
          userDescriptor,
          ef.embedding.map((d) => Number(d)),
        );

        if (distance > threshold) continue;

        const similarity = Number((1 - distance).toFixed(3));
        const existing = directMatchMap.get(ef.photoId);

        // Keep the highest-similarity face per photo
        if (!existing || similarity > existing.similarity) {
          directMatchMap.set(ef.photoId, {
            faceId: ef.id,
            similarity,
            confidence: Number(ef.confidence),
            bbox: ef.bbox,
            photo: ef.photo,
          });
        }
      }

      this.logger.log(`Direct face matches: ${directMatchMap.size} photos`);

      // ── Step 4: Identity resolution — expand to full athlete portfolio ──
      // This is where the magic happens: given the matched face IDs, we find:
      // - All confirmed bibs for those faces
      // - All photos that carry those bibs (even if face not visible in them)
      const matchedFaceIds = [...directMatchMap.values()].map((m) => m.faceId);
      const directPhotoIds = new Set(directMatchMap.keys());

      const portfolio = await this.identityResolver.resolveAthletePortfolio(
        eventId,
        matchedFaceIds,
        directPhotoIds,
      );

      this.logger.log(
        `Portfolio: ${portfolio.photos.length} total photos, ` +
          `bibs confirmed=[${portfolio.confirmedBibs.join(', ')}] ` +
          `inferred=[${portfolio.inferredBibs.join(', ')}]`,
      );

      // ── Step 5: Build unified result list ──
      // Start with portfolio (already includes direct face matches tagged correctly)
      const resultMap = new Map<string, FaceSearchResult>();

      // Add portfolio photos (BIB_VIA_FACE + INFERRED_VIA_FACE + FACE_DIRECT from bib side)
      for (const rp of portfolio.photos) {
        resultMap.set(rp.photoId, resolvedPhotoToFaceResult(rp));
      }

      // Ensure direct face matches are represented (some may not have any bib associations yet)
      for (const [photoId, dm] of directMatchMap) {
        if (!resultMap.has(photoId)) {
          const p = dm.photo;
          resultMap.set(photoId, {
            photoId,
            similarity: dm.similarity,
            confidence: dm.confidence,
            faceId: dm.faceId,
            bbox: dm.bbox as [number, number, number, number],
            thumbUrl: p.thumbUrl ?? '',
            watermarkUrl: p.watermarkUrl ?? '',
            originalUrl: p.originalUrl ?? '',
            discoveryType: 'FACE_DIRECT',
          });
        } else {
          // If already in portfolio, make sure similarity is accurate
          const existing = resultMap.get(photoId)!;
          if (dm.similarity > (existing.similarity ?? 0)) {
            resultMap.set(photoId, {
              ...existing,
              similarity: dm.similarity,
              faceId: dm.faceId,
              bbox: dm.bbox as [number, number, number, number],
              discoveryType: 'FACE_DIRECT',
            });
          }
        }
      }

      const sortedMatches = [...resultMap.values()].sort((a, b) => {
        // FACE_DIRECT > BIB_VIA_FACE > INFERRED_VIA_FACE, then by similarity/confidence
        const typePriority: Record<string, number> = {
          FACE_DIRECT: 3,
          BIB_VIA_FACE: 2,
          INFERRED_VIA_FACE: 1,
        };
        const ap = typePriority[a.discoveryType ?? 'BIB_VIA_FACE'] ?? 1;
        const bp = typePriority[b.discoveryType ?? 'BIB_VIA_FACE'] ?? 1;
        if (ap !== bp) return bp - ap;
        return (b.similarity ?? b.confidence ?? 0) - (a.similarity ?? a.confidence ?? 0);
      });

      const searchTime = Date.now() - startTime;
      this.logger.log(
        `Face search complete — ${sortedMatches.length} total results in ${searchTime}ms ` +
          `(${directMatchMap.size} direct, ${sortedMatches.length - directMatchMap.size} via bib graph)`,
      );

      return {
        matches: sortedMatches,
        total: sortedMatches.length,
        searchTime,
        userFaceDetected: true,
        confirmedBibs: portfolio.confirmedBibs,
        inferredBibs: portfolio.inferredBibs,
      };
    } catch (error) {
      this.logger.error(`Error in face search for event ${eventId}: ${getErrorMessage(error)}`);
      throw error;
    }
  }

  async getEventFaceStats(eventId: string): Promise<{
    totalPhotos: number;
    photosWithFaces: number;
    totalFacesDetected: number;
    averageFacesPerPhoto: number;
  }> {
    const [totalPhotos, faceStats] = await Promise.all([
      this.prisma.photo.count({ where: { eventId, status: 'PROCESSED' } }),
      this.prisma.faceEmbedding.groupBy({
        by: ['photoId'],
        where: { eventId },
        _count: { id: true },
      }),
    ]);

    const photosWithFaces = faceStats.length;
    const totalFacesDetected = faceStats.reduce((s, st) => s + st._count.id, 0);

    return {
      totalPhotos,
      photosWithFaces,
      totalFacesDetected,
      averageFacesPerPhoto: photosWithFaces > 0
        ? Number((totalFacesDetected / photosWithFaces).toFixed(2))
        : 0,
    };
  }

  convertToPhotoSearchResults(faceResults: FaceSearchResult[]): PhotoSearchResult[] {
    return faceResults.map((result) => ({
      photoId: result.photoId,
      thumbUrl: result.thumbUrl ?? '',
      watermarkUrl: result.watermarkUrl ?? '',
      originalUrl: result.originalUrl ?? '',
      confidence: result.similarity ?? result.confidence,
      takenAt: new Date().toISOString(),
    }));
  }
}

function resolvedPhotoToFaceResult(rp: ResolvedPhoto): FaceSearchResult {
  return {
    photoId: rp.photoId,
    similarity: rp.discoveryType === 'FACE_DIRECT' ? rp.confidence : undefined,
    confidence: rp.confidence,
    faceId: '',
    bbox: rp.faceBbox ?? ([] as unknown as [number, number, number, number]),
    thumbUrl: rp.thumbUrl,
    watermarkUrl: rp.watermarkUrl,
    originalUrl: rp.originalUrl,
    discoveryType: rp.discoveryType,
    detectedBibs: rp.detectedBibs,
  };
}
