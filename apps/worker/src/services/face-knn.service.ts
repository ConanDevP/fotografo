import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../api/src/common/services/prisma.service';
import { FACE_BIB_LINKING } from '@shared/constants';

interface FaceKnnIndex {
  createdAt: number;
  vectors: Float32Array[];
  bibs: string[];
  faceEmbeddingIds: string[];
  /// Foto de origen de cada entrada. Dos caras en una misma fotografía son dos
  /// personas distintas, así que jamás deben emparejarse entre ellas.
  photoIds: string[];
}

export interface FaceKnnMatch {
  bib: string;
  distance: number;
  confidence: number;
  sourceFaceEmbeddingId: string;
}

@Injectable()
export class FaceKnnService {
  private readonly logger = new Logger(FaceKnnService.name);
  private readonly cache = new Map<string, FaceKnnIndex>();
  /**
   * El índice se mantiene al día añadiendo cada asociación nueva en memoria, así
   * que no caduca por tiempo. Antes se invalidaba antes de cada fotografía y se
   * reconstruía entero desde la base de datos: como el índice crece con el
   * evento, el coste total era cuadrático y las últimas fotografías de una
   * carrera tardaban órdenes de magnitud más que las primeras.
   */

  constructor(private prisma: PrismaService) { }

  /** Solo para cambios que este proceso no ha visto, como una edición manual. */
  invalidate(eventId: string) {
    this.cache.delete(eventId);
    this.logger.log(`[KNN] Cache invalidated for event ${eventId}`);
  }

  /**
   * Incorpora una asociación recién creada sin releer el evento entero. Es lo
   * que permite que el índice siga vivo entre fotografías.
   */
  addToIndex(eventId: string, entry: { faceEmbeddingId: string; photoId: string; bib: string; embedding: number[] }) {
    const index = this.cache.get(eventId);
    if (!index) return;
    if (index.faceEmbeddingIds.includes(entry.faceEmbeddingId)) return;

    const vector = this.normalize(entry.embedding);
    if (!vector) return;

    index.vectors.push(vector);
    index.bibs.push(entry.bib);
    index.faceEmbeddingIds.push(entry.faceEmbeddingId);
    index.photoIds.push(entry.photoId);
  }

  invalidateAll() {
    this.cache.clear();
    this.logger.log(`[KNN] All caches invalidated`);
  }

  async findMatches(
    eventId: string,
    queryEmbedding: number[],
    topK: number,
    /// Fotografía de la cara consultada: sus propias caras se excluyen porque
    /// pertenecen necesariamente a otras personas.
    excludePhotoId?: string,
  ): Promise<FaceKnnMatch[]> {
    const index = await this.getIndex(eventId);
    if (!index || index.vectors.length === 0) {
      return [];
    }

    const queryVector = this.normalize(queryEmbedding);
    if (!queryVector) {
      return [];
    }

    const scores: FaceKnnMatch[] = [];

    for (let i = 0; i < index.vectors.length; i++) {
      const candidate = index.vectors[i];
      if (candidate.length !== queryVector.length) {
        continue;
      }
      if (excludePhotoId && index.photoIds[i] === excludePhotoId) {
        continue;
      }
      const similarity = this.cosineSimilarity(queryVector, candidate);
      const confidence = Math.max(0, Math.min(1, similarity));
      const distance = 1 - confidence;
      scores.push({
        bib: index.bibs[i],
        distance,
        confidence,
        sourceFaceEmbeddingId: index.faceEmbeddingIds[i],
      });
    }

    scores.sort((a, b) => a.distance - b.distance);
    return scores.slice(0, topK);
  }

  private async getIndex(eventId: string): Promise<FaceKnnIndex | null> {
    const cached = this.cache.get(eventId);
    if (cached) {
      return cached;
    }

    const rebuilt = await this.buildIndex(eventId);
    if (rebuilt) {
      this.cache.set(eventId, rebuilt);
    }
    return rebuilt;
  }

  private async buildIndex(eventId: string): Promise<FaceKnnIndex | null> {
    const embeddings = await this.prisma.faceEmbedding.findMany({
      where: {
        eventId,
        faceBibAssociations: {
          some: {
            method: {
              in: ['SPATIAL', 'MANUAL', 'INFERRED', 'AUTO_KNN'],
            },
            bib: { not: '' },
          },
        },
      },
      select: {
        id: true,
        photoId: true,
        embedding: true,
        faceBibAssociations: {
          select: {
            bib: true,
            method: true,
            photoBib: {
              select: {
                confidence: true,
              },
            },
          },
        },
      },
    });

    if (embeddings.length === 0) {
      this.logger.warn(`[KNN] No indexed embeddings available for event ${eventId} - check if FaceBibAssociations exist`);
      return { createdAt: Date.now(), vectors: [], bibs: [], faceEmbeddingIds: [], photoIds: [] };
    }

    this.logger.log(`[KNN] Found ${embeddings.length} embeddings with associations for event ${eventId}`);

    const vectors: Float32Array[] = [];
    const bibs: string[] = [];
    const faceEmbeddingIds: string[] = [];
    const photoIds: string[] = [];

    for (const record of embeddings) {
      const bibAssociation = this.pickBestAssociation(record.faceBibAssociations);
      if (!bibAssociation) {
        continue;
      }

      const vector = this.normalize(record.embedding);
      if (!vector) {
        continue;
      }

      vectors.push(vector);
      bibs.push(bibAssociation.bib);
      faceEmbeddingIds.push(record.id);
      photoIds.push(record.photoId);
    }

    this.logger.log(
      `KNN index built for event ${eventId}: ${vectors.length} embeddings ready`
    );

    return {
      createdAt: Date.now(),
      vectors,
      bibs,
      faceEmbeddingIds,
      photoIds,
    };
  }

  private pickBestAssociation(
    associations: Array<{
      bib: string;
      method: string;
      photoBib: { confidence: any } | null;
    }>
  ): { bib: string } | null {
    if (!associations || associations.length === 0) {
      return null;
    }

    const filtered = associations.filter(
      assoc =>
        assoc.photoBib === null ||
        Number(assoc.photoBib.confidence ?? 0) >= FACE_BIB_LINKING.INDEX_MIN_CONFIDENCE
    );

    const source = filtered.length > 0 ? filtered : associations;
    source.sort((a, b) => {
      const confA = Number(a.photoBib?.confidence ?? 0);
      const confB = Number(b.photoBib?.confidence ?? 0);
      return confB - confA;
    });

    const chosen = source[0];
    return chosen ? { bib: chosen.bib } : null;
  }

  private normalize(values: number[] | Float32Array): Float32Array | null {
    const length = values.length;
    if (length === 0) {
      return null;
    }

    const arr = new Float32Array(length);
    let norm = 0;
    for (let i = 0; i < length; i++) {
      const value = Number(values[i]);
      arr[i] = value;
      norm += value * value;
    }

    if (!Number.isFinite(norm) || norm === 0) {
      return null;
    }

    const inv = 1 / Math.sqrt(norm);
    for (let i = 0; i < length; i++) {
      arr[i] *= inv;
    }

    return arr;
  }

  private cosineSimilarity(a: Float32Array, b: Float32Array): number {
    let dotProduct = 0;
    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
    }
    return Math.max(-1, Math.min(1, dotProduct));
  }
}
