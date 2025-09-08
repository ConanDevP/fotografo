import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../common/services/prisma.service';
import { StorageService } from '../common/services/storage.service';
import { PythonFaceApiService } from '../../../worker/src/services/python-face-api.service';
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
    private storageService: StorageService,
    private pythonFaceApiService: PythonFaceApiService,
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

      // Check if Python Face API is ready
      if (!this.pythonFaceApiService.isReadySync()) {
        throw new BadRequestException({
          code: ERROR_CODES.INTERNAL_ERROR,
          message: 'Face recognition service is not available',
        });
      }

      // Step 1: Extract face descriptor from user's image
      this.logger.log(`Extracting face from user image for event ${eventId}`);
      
      // Clean up the base64 string
      const base64Data = searchRequest.userImageBase64.split(',').pop() || '';
      const imageBuffer = Buffer.from(base64Data, 'base64');
      this.logger.log(`Image buffer size: ${imageBuffer.length} bytes`);
      
      // Upload search image temporarily to R2 to get a signed URL (same as when processing photos)
      const tempImageKey = `temp/search/${Date.now()}-${Math.random().toString(36).substring(7)}.jpg`;
      
      this.logger.log(`Uploading search image temporarily to R2: ${tempImageKey}`);
      
      // Upload image buffer to R2
      await this.storageService.uploadImage(imageBuffer, tempImageKey);
      
      // Generate signed URL for the temporary image
      const tempImageUrl = await this.storageService.generateSecureDownloadUrl(tempImageKey, 900); // 15 minutes
      this.logger.log(`Generated signed URL for search image: ${tempImageUrl.substring(0, 100)}...`);
      
      let userFaceDescriptor: Float32Array | null = null;
      
      try {
        // Use detectAllFaces() with URL (same method that works for event photos)
        const faces = await this.pythonFaceApiService.detectAllFaces(tempImageUrl, 1);
        
        if (faces.length > 0) {
          userFaceDescriptor = new Float32Array(faces[0].embedding);
          this.logger.log(`Face extracted successfully from search image! Confidence: ${faces[0].confidence}`);
        } else {
          this.logger.warn(`No face detected in search image using URL method`);
        }
      } finally {
        // Clean up temporary image
        try {
          await this.storageService.deleteImage(tempImageKey);
          this.logger.log(`Cleaned up temporary search image: ${tempImageKey}`);
        } catch (cleanupError) {
          this.logger.warn(`Failed to cleanup temporary image ${tempImageKey}:`, cleanupError);
        }
      }
      
      this.logger.log(`Face descriptor extracted: ${userFaceDescriptor ? 'SUCCESS' : 'FAILED'}`);

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

      // Step 3: Calculate similarities and find matches
      const threshold = searchRequest.threshold || FACE_RECOGNITION.DEFAULT_THRESHOLD;
      const userDescriptor = Array.from(userFaceDescriptor);

      this.logger.log(`Found ${eventFaces.length} faces to compare against`);
      
      if (eventFaces.length === 0) {
        this.logger.error(`NO FACE EMBEDDINGS FOUND IN DATABASE for event ${eventId}!`);
        return {
          matches: [],
          total: 0,
          searchTime: Date.now() - startTime,
          userFaceDetected: true,
        };
      }
      
      this.logger.log(`User descriptor length: ${userDescriptor.length}`);
      this.logger.log(`First DB embedding length: ${eventFaces[0].embedding.length}`);
      const matches: FaceSearchResult[] = [];

      for (const eventFace of eventFaces) {
        // Skip if photo is not processed
        if (eventFace.photo.status !== 'PROCESSED') {
          continue;
        }

        // Convert embedding to number array for comparison
        const faceDescriptor = eventFace.embedding.map(d => Number(d));
        
        // Calculate cosine distance using Python Face API service (lower is better)
        const distance = this.pythonFaceApiService.calculateDistance(
          userDescriptor,
          faceDescriptor
        );

        this.logger.debug(`Photo ${eventFace.photoId}: distance=${distance.toFixed(4)}, threshold=${threshold}`);

        // Check if it's a match (distance is below the threshold)
        if (distance <= threshold) {
          matches.push({
            photoId: eventFace.photoId,
            similarity: Number((1 - distance).toFixed(3)), // Still show similarity to the frontend
            confidence: Number(eventFace.confidence),
            faceId: eventFace.id,
            bbox: eventFace.bbox as [number, number, number, number],
            thumbUrl: eventFace.photo.thumbUrl || '',
            watermarkUrl: eventFace.photo.watermarkUrl || '',
            originalUrl: eventFace.photo.originalUrl || '',
          });
        }
      }

      // Step 4: Sort matches by similarity (highest first)
      const sortedMatches = matches.sort((a, b) => b.similarity - a.similarity);

      const searchTime = Date.now() - startTime;
      
      this.logger.log(`Face search completed: ${sortedMatches.length} matches found in ${searchTime}ms`);
      
      if (sortedMatches.length === 0) {
        this.logger.warn(`No matches found! Threshold: ${threshold}, Total faces checked: ${eventFaces.length}`);
        // Log some sample distances for debugging
        const sampleDistances = matches.slice(0, 3).map(m => `${m.similarity}`);
        if (sampleDistances.length > 0) {
          this.logger.debug(`Sample distances: ${sampleDistances.join(', ')}`);
        }
      }

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