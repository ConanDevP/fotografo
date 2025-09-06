import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../common/services/prisma.service';
import { FaceApiService } from '../../../worker/src/services/face-api.service';
import { 
  FaceSearchRequest, 
  FaceSearchResponse, 
  FaceSearchResult,
  PhotoSearchResult 
} from '@shared/types';
import { FACE_RECOGNITION, ERROR_CODES } from '@shared/constants';
import { getErrorMessage } from '@shared/utils';

@Injectable()
export class FaceSearchService {
  private readonly logger = new Logger(FaceSearchService.name);

  constructor(
    private prisma: PrismaService,
    private faceApiService: FaceApiService,
  ) {}

  async searchPhotosByFace(
    eventId: string,
    searchRequest: FaceSearchRequest,
  ): Promise<FaceSearchResponse> {
    const startTime = Date.now();
    
    try {
      // Verify event exists
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

      // Check if Face API is ready
      if (!this.faceApiService.isReady()) {
        throw new BadRequestException({
          code: ERROR_CODES.INTERNAL_ERROR,
          message: 'Face recognition service is not available',
        });
      }

      // Step 1: Extract face descriptor from user's image
      this.logger.log(`Extracting face from user image for event ${eventId}`);
      
      const imageBuffer = Buffer.from(searchRequest.userImageBase64, 'base64');
      const userFaceDescriptor = await this.faceApiService.extractFaceDescriptor(imageBuffer);

      if (!userFaceDescriptor) {
        return {
          matches: [],
          total: 0,
          searchTime: Date.now() - startTime,
          userFaceDetected: false,
        };
      }

      this.logger.log(`User face detected, searching for matches in event ${eventId}`);

      // Step 2: Get all face embeddings from the event
      const eventFaces = await this.prisma.faceEmbedding.findMany({
        where: { eventId },
        include: {
          photo: {
            select: {
              id: true,
              thumbUrl: true,
              watermarkUrl: true, 
              originalUrl: true,
              status: true,
            },
          },
        },
      });

      this.logger.log(`Found ${eventFaces.length} faces to compare against`);

      // Step 3: Calculate similarities and find matches
      const threshold = searchRequest.threshold || FACE_RECOGNITION.DEFAULT_THRESHOLD;
      const userDescriptor = Array.from(userFaceDescriptor);
      const matches: FaceSearchResult[] = [];

      for (const eventFace of eventFaces) {
        // Skip if photo is not processed
        if (eventFace.photo.status !== 'PROCESSED') {
          continue;
        }

        // Convert Decimal[] to number[] for comparison
        const faceDescriptor = eventFace.embedding.map(d => Number(d));
        
        // Calculate similarity
        const similarity = this.faceApiService.calculateSimilarity(
          userDescriptor,
          faceDescriptor
        );

        // Check if it's a match
        if (similarity >= threshold) {
          matches.push({
            photoId: eventFace.photoId,
            similarity: Number(similarity.toFixed(3)),
            confidence: Number(eventFace.confidence),
            faceId: eventFace.id,
            bbox: eventFace.bbox as [number, number, number, number],
            thumbUrl: eventFace.photo.thumbUrl || '',
            watermarkUrl: eventFace.photo.watermarkUrl || '',
            originalUrl: eventFace.photo.originalUrl || '',
          });
        }
      }

      // Step 4: Sort matches by similarity (highest first) and remove duplicates
      const uniqueMatches = this.deduplicateMatches(matches);
      const sortedMatches = uniqueMatches.sort((a, b) => b.similarity - a.similarity);

      const searchTime = Date.now() - startTime;
      
      this.logger.log(`Face search completed: ${sortedMatches.length} matches found in ${searchTime}ms`);

      return {
        matches: sortedMatches,
        total: sortedMatches.length,
        searchTime,
        userFaceDetected: true,
      };

    } catch (error) {
      const errorMessage = getErrorMessage(error);
      this.logger.error(`Error in face search for event ${eventId}: ${errorMessage}`);
      throw error;
    }
  }

  async getEventFaceStats(eventId: string): Promise<{
    totalPhotos: number;
    photosWithFaces: number;
    totalFacesDetected: number;
    averageFacesPerPhoto: number;
  }> {
    try {
      const [totalPhotos, faceStats] = await Promise.all([
        this.prisma.photo.count({
          where: { eventId, status: 'PROCESSED' },
        }),
        this.prisma.faceEmbedding.groupBy({
          by: ['photoId'],
          where: { eventId },
          _count: { id: true },
        }),
      ]);

      const photosWithFaces = faceStats.length;
      const totalFacesDetected = faceStats.reduce((sum, stat) => sum + stat._count.id, 0);
      const averageFacesPerPhoto = photosWithFaces > 0 ? totalFacesDetected / photosWithFaces : 0;

      return {
        totalPhotos,
        photosWithFaces,
        totalFacesDetected,
        averageFacesPerPhoto: Number(averageFacesPerPhoto.toFixed(2)),
      };
    } catch (error) {
      this.logger.error(`Error getting face stats for event ${eventId}:`, error);
      throw error;
    }
  }

  private deduplicateMatches(matches: FaceSearchResult[]): FaceSearchResult[] {
    const photoMap = new Map<string, FaceSearchResult>();
    
    for (const match of matches) {
      const existing = photoMap.get(match.photoId);
      
      // If this photo already has a match, keep the one with higher similarity
      if (!existing || match.similarity > existing.similarity) {
        photoMap.set(match.photoId, match);
      }
    }
    
    return Array.from(photoMap.values());
  }

  // Convert face search results to photo search results format for compatibility
  convertToPhotoSearchResults(faceResults: FaceSearchResult[]): PhotoSearchResult[] {
    return faceResults.map(result => ({
      photoId: result.photoId,
      thumbUrl: result.thumbUrl || '',
      watermarkUrl: result.watermarkUrl || '',
      originalUrl: result.originalUrl || '', 
      confidence: result.similarity, // Use similarity as confidence
      takenAt: new Date().toISOString(), // Would need to join with photo table for actual takenAt
    }));
  }
}