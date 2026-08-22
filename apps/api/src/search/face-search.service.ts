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
import { ConfigService } from '@nestjs/config';

@Injectable()
export class FaceSearchService {
  private readonly logger = new Logger(FaceSearchService.name);

  constructor(
    private prisma: PrismaService,
    private storageService: StorageService,
    private pythonFaceApiService: PythonFaceApiService,
    private identityResolver: IdentityResolverService,
    private configService: ConfigService,
  ) {}

  async searchPhotosByFace(
    eventId: string,
    searchRequest: FaceSearchRequest,
  ): Promise<FaceSearchResponse> {
    const startTime = Date.now();

    try {
      // ── Verify event ──
      const event = await this.prisma.event.findUnique({
        where: { id: eventId, deletedAt: null, isPublished: true },
        select: { id: true, name: true },
      });
      if (!event) {
        throw new NotFoundException({
          code: ERROR_CODES.EVENT_NOT_FOUND,
          message: 'Event not found',
        });
      }

      if (!(await this.pythonFaceApiService.isReady())) {
        throw new BadRequestException({
          code: ERROR_CODES.INTERNAL_ERROR,
          message: 'Face recognition service is not available',
        });
      }

      // ── Step 1: Extract face embedding from uploaded selfie ──
      this.logger.log(`Extracting face from user image for event ${eventId}`);

      const base64Data = searchRequest.userImageBase64.split(',').pop() || '';
      const imageBuffer = Buffer.from(base64Data, 'base64');
      if (imageBuffer.length === 0 || imageBuffer.length > 6 * 1024 * 1024) {
        throw new BadRequestException('La selfie debe pesar menos de 6 MB');
      }

      let normalizedImage: Buffer;
      try {
        normalizedImage = await this.storageService.prepareFaceSearchImage(imageBuffer);
      } catch {
        throw new BadRequestException('La selfie no es una imagen JPG, PNG o WEBP válida');
      }

      const tempImageKey = `temp/search/${Date.now()}-${Math.random().toString(36).substring(7)}.jpg`;
      const temporaryImage = await this.storageService.uploadPrivateTemporaryImage(normalizedImage, tempImageKey);

      let userFaceDescriptor: Float32Array | null = null;

      try {
        const tempImageUrl = await this.storageService.generateSecureDownloadUrl(temporaryImage.key, 300);
        const faces = await this.pythonFaceApiService.detectAllFaces(tempImageUrl, 1);
        if (faces.length > 0) {
          userFaceDescriptor = new Float32Array(faces[0].embedding);
          this.logger.log(`Face extracted. Confidence: ${faces[0].confidence}`);
        } else {
          this.logger.warn('No face detected in search image');
        }
      } finally {
        try {
          await this.storageService.deleteImage(temporaryImage.key);
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

      // ── Step 2: Compare in bounded batches so a large event cannot exhaust API memory ──
      const threshold = searchRequest.threshold ?? FACE_RECOGNITION.DEFAULT_THRESHOLD;
      const userDescriptor = Array.from(userFaceDescriptor);
      type SearchPhoto = {
        id: string;
        thumbUrl: string | null;
        watermarkUrl: string | null;
        takenAt: Date | null;
        createdAt: Date;
        status: string;
      };
      const directMatchMap = new Map<
        string,
        { faceId: string; similarity: number; confidence: number; bbox: any; photo: SearchPhoto }
      >();

      // ── Búsqueda por vecino más cercano dentro de Postgres ──
      //
      // Antes se traían todos los embeddings del evento y se comparaba en Node:
      // decenas de MB por consulta y un fallo en firme al superar cierto tamaño.
      // Con el índice HNSW, Postgres devuelve solo los candidatos y no se
      // transfiere ningún vector. `<=>` es distancia coseno, la misma métrica
      // que se usaba antes, así que el umbral conserva su significado.
      const maxCandidates = Math.max(
        1,
        Number(this.configService.get('FACE_SEARCH_MAX_CANDIDATES', 200)) || 200,
      );
      const queryVector = `[${userDescriptor.join(',')}]`;

      // `hnsw.ef_search` es la anchura del recorrido del índice y por defecto
      // vale 40. Con un LIMIT mayor, pgvector devolvería menos candidatos de los
      // pedidos y perdería coincidencias buenas, así que se sube por transacción.
      const rows = await this.prisma.$transaction(async tx => {
        await tx.$executeRawUnsafe(`SET LOCAL hnsw.ef_search = ${Math.max(40, maxCandidates * 2)}`);
        return tx.$queryRaw<Array<{
        id: string;
        photo_id: string;
        confidence: any;
        bbox: any;
        distance: number;
        p_id: string;
        thumb_url: string | null;
        watermark_url: string | null;
        taken_at: Date | null;
        created_at: Date;
        status: string;
      }>>`
        SELECT fe."id",
               fe."photo_id",
               fe."confidence",
               fe."bounding_box" AS bbox,
               (fe."embedding_vec" <=> ${queryVector}::vector) AS distance,
               p."id" AS p_id,
               p."thumb_url",
               p."watermark_url",
               p."taken_at",
               p."created_at",
               p."status"::text AS status
        FROM "face_embeddings" fe
        JOIN "photos" p ON p."id" = fe."photo_id"
        WHERE fe."event_id" = ${eventId}::uuid
          AND fe."embedding_vec" IS NOT NULL
          AND p."status" = 'PROCESSED'
          AND p."publication_status" = 'APPROVED'
        ORDER BY fe."embedding_vec" <=> ${queryVector}::vector
        LIMIT ${maxCandidates}
      `;
      });

      const comparedFaces = rows.length;
      for (const row of rows) {
        const distance = Number(row.distance);
        if (distance > threshold) continue;
        const similarity = Number((1 - distance).toFixed(3));
        const existing = directMatchMap.get(row.photo_id);
        if (!existing || similarity > existing.similarity) {
          directMatchMap.set(row.photo_id, {
            faceId: row.id,
            similarity,
            confidence: Number(row.confidence),
            bbox: row.bbox,
            photo: {
              id: row.p_id,
              thumbUrl: row.thumb_url,
              watermarkUrl: row.watermark_url,
              takenAt: row.taken_at,
              createdAt: row.created_at,
              status: row.status,
            },
          });
        }
      }

      this.logger.log(`Compared selfie against ${comparedFaces} face embeddings`);
      if (comparedFaces === 0) {
        return { matches: [], total: 0, searchTime: Date.now() - startTime, userFaceDetected: true };
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
            originalUrl: '',
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
    const event = await this.prisma.event.findUnique({
      where: { id: eventId, deletedAt: null, isPublished: true },
      select: { id: true },
    });
    if (!event) throw new NotFoundException('Evento no encontrado');

    const [totalPhotos, faceStats] = await Promise.all([
      this.prisma.photo.count({
        where: { eventId, status: 'PROCESSED', publicationStatus: 'APPROVED' },
      }),
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
      originalUrl: '',
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
    originalUrl: '',
    discoveryType: rp.discoveryType,
    detectedBibs: rp.detectedBibs,
  };
}
