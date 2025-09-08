import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { PrismaService } from '../common/services/prisma.service';
import { QueueService } from '../common/services/queue.service';
import { CloudinaryService } from '../common/services/cloudinary.service';
import { SearchResponse, PhotoSearchResult } from '@shared/types';
import { ERROR_CODES, PAGINATION } from '@shared/constants';
import { getErrorMessage } from '@shared/utils';

@Injectable()
export class SearchService {
  private readonly logger = new Logger(SearchService.name);
  
  constructor(
    private prisma: PrismaService,
    private queueService: QueueService,
    private cloudinaryService: CloudinaryService,
  ) {}

  async searchPhotosByBib(
    eventId: string,
    bib: string,
    limit: number = PAGINATION.DEFAULT_LIMIT,
    cursor?: string,
  ): Promise<SearchResponse> {
    // Validate event exists
    const event = await this.prisma.event.findUnique({
      where: { id: eventId },
      select: { id: true, name: true },
    });

    if (!event) {
      throw new NotFoundException({
        code: ERROR_CODES.EVENT_NOT_FOUND,
        message: 'Evento no encontrado',
      });
    }

    // Validate bib format
    if (!bib || bib.trim().length === 0) {
      throw new BadRequestException({
        code: ERROR_CODES.INVALID_BIB_FORMAT,
        message: 'Formato de dorsal inválido',
      });
    }

    const normalizedBib = bib.trim();
    const limitNum = Math.min(limit, PAGINATION.MAX_LIMIT);

    // Build cursor-based pagination
    let cursorCondition = {};
    if (cursor) {
      try {
        const decodedCursor = JSON.parse(Buffer.from(cursor, 'base64').toString());
        cursorCondition = {
          OR: [
            {
              confidence: { lt: decodedCursor.confidence },
            },
            {
              confidence: decodedCursor.confidence,
              photo: {
                takenAt: { lt: new Date(decodedCursor.takenAt) },
              },
            },
            {
              confidence: decodedCursor.confidence,
              photo: {
                takenAt: new Date(decodedCursor.takenAt),
                id: { lt: decodedCursor.photoId },
              },
            },
          ],
        };
      } catch (error) {
        throw new BadRequestException({
          code: ERROR_CODES.VALIDATION_ERROR,
          message: 'Cursor inválido',
        });
      }
    }

    // Search for photos with matching bibs
    const photoBibs = await this.prisma.photoBib.findMany({
      where: {
        eventId,
        bib: normalizedBib,
        photo: {
          status: 'PROCESSED',
          watermarkUrl: { not: null },
          thumbUrl: { not: null },
        },
        ...cursorCondition,
      },
      include: {
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
      orderBy: [
        { confidence: 'desc' },
        { photo: { takenAt: 'desc' } },
        { photo: { id: 'desc' } },
      ],
      take: limitNum + 1, // Take one extra to determine if there are more results
    });

    // Check if there are more results
    const hasMore = photoBibs.length > limitNum;
    const results = hasMore ? photoBibs.slice(0, limitNum) : photoBibs;

    // Transform to response format
    const items: PhotoSearchResult[] = results.map(photoBib => ({
      photoId: photoBib.photo.id,
      thumbUrl: photoBib.photo.thumbUrl!,
      watermarkUrl: photoBib.photo.watermarkUrl!,
      originalUrl: photoBib.photo.originalUrl!,
      confidence: Number(photoBib.confidence),
      takenAt: photoBib.photo.takenAt?.toISOString() || photoBib.photo.createdAt.toISOString(),
    }));

    // Generate next cursor
    let nextCursor;
    if (hasMore && results.length > 0) {
      const lastItem = results[results.length - 1];
      const cursorData = {
        confidence: Number(lastItem.confidence),
        takenAt: lastItem.photo.takenAt?.toISOString() || lastItem.photo.createdAt.toISOString(),
        photoId: lastItem.photo.id,
      };
      nextCursor = Buffer.from(JSON.stringify(cursorData)).toString('base64');
    }

    // Get total count for this bib (for analytics)
    const totalCount = await this.prisma.photoBib.count({
      where: {
        eventId,
        bib: normalizedBib,
        photo: {
          status: 'PROCESSED',
          watermarkUrl: { not: null },
        },
      },
    });

    return {
      items,
      nextCursor,
      total: totalCount,
    };
  }

  async searchPhotosByBibOptimized(
    eventId: string,
    bib: string,
  ): Promise<{ items: PhotoSearchResult[]; total: number }> {
    // Validate event exists
    const event = await this.prisma.event.findUnique({
      where: { id: eventId },
      select: { id: true, name: true },
    });

    if (!event) {
      throw new NotFoundException({
        code: ERROR_CODES.EVENT_NOT_FOUND,
        message: 'Evento no encontrado',
      });
    }

    const normalizedBib = bib.trim();

    try {
      // Get photos directly from organized Cloudinary folders
      const bibFolderContents = await this.cloudinaryService.getBibFolderContents(eventId, normalizedBib);
      
      // Extract photo IDs from URLs and get photo metadata
      const photoIds = this.extractPhotoIdsFromUrls(bibFolderContents.thumbs);
      
      if (photoIds.length === 0) {
        return { items: [], total: 0 };
      }

      // Get photo metadata from database
      const photoBibs = await this.prisma.photoBib.findMany({
        where: {
          eventId,
          bib: normalizedBib,
          photoId: { in: photoIds },
          photo: {
            status: 'PROCESSED',
          },
        },
        include: {
          photo: {
            select: {
              id: true,
              takenAt: true,
              createdAt: true,
            },
          },
        },
        orderBy: [
          { confidence: 'desc' },
          { photo: { takenAt: 'desc' } },
        ],
      });

      // Build results using organized URLs
      const items: PhotoSearchResult[] = photoBibs.map(photoBib => {
        const photoId = photoBib.photo.id;
        const thumbUrl = bibFolderContents.thumbs.find(url => url.includes(photoId));
        const watermarkUrl = bibFolderContents.watermarks.find(url => url.includes(photoId));
        const originalUrl = bibFolderContents.originals.find(url => url.includes(photoId));
        
        return {
          photoId,
          thumbUrl: thumbUrl || '',
          watermarkUrl: watermarkUrl || '',
          originalUrl: originalUrl || '',
          confidence: Number(photoBib.confidence),
          takenAt: photoBib.photo.takenAt?.toISOString() || photoBib.photo.createdAt.toISOString(),
        };
      }).filter(item => item.thumbUrl && item.watermarkUrl); // Only include items with valid URLs

      return {
        items,
        total: items.length,
      };
    } catch (error) {
      // Fallback to database search if Cloudinary folders don't exist yet
      this.logger.warn(`Fallback to database search for bib ${normalizedBib}: ${getErrorMessage(error)}`);
      const dbResult = await this.searchPhotosByBib(eventId, bib, PAGINATION.MAX_LIMIT);
      return {
        items: dbResult.items,
        total: dbResult.total || 0,
      };
    }
  }

  private extractPhotoIdsFromUrls(urls: string[]): string[] {
    return urls
      .map(url => {
        // Extract photo ID from Cloudinary URL
        const match = url.match(/\/([a-f0-9-]{36})-/);
        return match ? match[1] : null;
      })
      .filter((id): id is string => id !== null);
  }

  async subscribeToNotifications(
    eventId: string,
    bib: string,
    email: string,
  ): Promise<{ message: string }> {
    // Validate event exists
    const event = await this.prisma.event.findUnique({
      where: { id: eventId },
      select: { id: true },
    });

    if (!event) {
      throw new NotFoundException({
        code: ERROR_CODES.EVENT_NOT_FOUND,
        message: 'Evento no encontrado',
      });
    }

    // Validate inputs
    if (!bib || bib.trim().length === 0) {
      throw new BadRequestException({
        code: ERROR_CODES.INVALID_BIB_FORMAT,
        message: 'Formato de dorsal inválido',
      });
    }

    const normalizedBib = bib.trim();
    const normalizedEmail = email.toLowerCase().trim();

    // Check if subscription already exists
    const existingSubscription = await this.prisma.bibSubscription.findFirst({
      where: {
        eventId,
        bib: normalizedBib,
        email: normalizedEmail,
      },
    });

    if (existingSubscription) {
      return { message: 'Ya estás suscrito a las notificaciones de este dorsal' };
    }

    // Create subscription
    await this.prisma.bibSubscription.create({
      data: {
        eventId,
        bib: normalizedBib,
        email: normalizedEmail,
      },
    });

    // Check if there are already existing photos for this bib
    const existingPhotos = await this.prisma.photoBib.findMany({
      where: {
        eventId,
        bib: normalizedBib,
        photo: {
          status: 'PROCESSED',
          watermarkUrl: { not: null },
        },
      },
      select: {
        photoId: true,
      },
      take: 20, // Limit to avoid overwhelming emails
    });

    // If there are existing photos, send immediate notification
    if (existingPhotos.length > 0) {
      await this.queueService.addSendEmailJob({
        eventId,
        bib: normalizedBib,
        email: normalizedEmail,
        photoIds: existingPhotos.map(p => p.photoId),
      });
    }

    return { message: 'Suscripción creada correctamente' };
  }

  async sendPhotosToEmail(
    eventId: string,
    bib: string,
    email: string,
    selectedPhotoIds?: string[],
  ): Promise<{ message: string }> {
    // Validate event exists
    const event = await this.prisma.event.findUnique({
      where: { id: eventId },
      select: { id: true },
    });

    if (!event) {
      throw new NotFoundException({
        code: ERROR_CODES.EVENT_NOT_FOUND,
        message: 'Evento no encontrado',
      });
    }

    const normalizedBib = bib.trim();
    const normalizedEmail = email.toLowerCase().trim();

    // If specific photos are selected, validate they belong to the bib
    if (selectedPhotoIds && selectedPhotoIds.length > 0) {
      const validPhotos = await this.prisma.photoBib.findMany({
        where: {
          eventId,
          bib: normalizedBib,
          photoId: { in: selectedPhotoIds },
          photo: {
            status: 'PROCESSED',
            watermarkUrl: { not: null },
          },
        },
        select: { photoId: true },
      });

      if (validPhotos.length !== selectedPhotoIds.length) {
        throw new BadRequestException({
          code: ERROR_CODES.VALIDATION_ERROR,
          message: 'Algunas fotos seleccionadas no son válidas',
        });
      }
    }

    // Enqueue email job
    await this.queueService.addSendEmailJob({
      eventId,
      bib: normalizedBib,
      email: normalizedEmail,
      photoIds: selectedPhotoIds,
    });

    return { message: 'Las fotos se enviarán por correo en breve' };
  }

  async getPopularBibs(eventId: string, limit = 10): Promise<Array<{ bib: string; photoCount: number }>> {
    const popularBibs = await this.prisma.photoBib.groupBy({
      by: ['bib'],
      where: {
        eventId,
        photo: {
          status: 'PROCESSED',
        },
      },
      _count: {
        bib: true,
      },
      orderBy: {
        _count: {
          bib: 'desc',
        },
      },
      take: limit,
    });

    return popularBibs.map(item => ({
      bib: item.bib,
      photoCount: item._count.bib,
    }));
  }

  async searchOriginalPhotosByBib(
    eventId: string,
    bib: string,
    limit: number = PAGINATION.DEFAULT_LIMIT,
    cursor?: string,
  ): Promise<SearchResponse> {
    return this.searchPhotosByBibAndType(eventId, bib, 'original', limit, cursor);
  }

  async searchWatermarkPhotosByBib(
    eventId: string,
    bib: string,
    limit: number = PAGINATION.DEFAULT_LIMIT,
    cursor?: string,
  ): Promise<SearchResponse> {
    return this.searchPhotosByBibAndType(eventId, bib, 'watermark', limit, cursor);
  }

  async searchThumbPhotosByBib(
    eventId: string,
    bib: string,
    limit: number = PAGINATION.DEFAULT_LIMIT,
    cursor?: string,
  ): Promise<SearchResponse> {
    return this.searchPhotosByBibAndType(eventId, bib, 'thumb', limit, cursor);
  }

  async getAllWatermarkPhotos(
    eventId: string,
    limit: number = PAGINATION.DEFAULT_LIMIT,
    cursor?: string,
  ): Promise<SearchResponse> {
    // Validate event exists
    const event = await this.prisma.event.findUnique({
      where: { id: eventId },
      select: { id: true, name: true },
    });

    if (!event) {
      throw new NotFoundException({
        code: ERROR_CODES.EVENT_NOT_FOUND,
        message: 'Evento no encontrado',
      });
    }

    const limitNum = Math.min(limit, PAGINATION.MAX_LIMIT);

    // Build cursor-based pagination
    let cursorCondition = {};
    if (cursor) {
      try {
        const decodedCursor = JSON.parse(Buffer.from(cursor, 'base64').toString());
        cursorCondition = {
          OR: [
            {
              takenAt: { lt: new Date(decodedCursor.takenAt) },
            },
            {
              takenAt: new Date(decodedCursor.takenAt),
              id: { lt: decodedCursor.photoId },
            },
          ],
        };
      } catch (error) {
        throw new BadRequestException({
          code: ERROR_CODES.VALIDATION_ERROR,
          message: 'Cursor inválido',
        });
      }
    }

    // Get ALL photos with watermark from event (not just those with bibs)
    const photos = await this.prisma.photo.findMany({
      where: {
        eventId,
        status: 'PROCESSED',
        watermarkUrl: { not: null },
        ...cursorCondition,
      },
      select: {
        id: true,
        watermarkUrl: true,
        thumbUrl: true,
        originalUrl: true,
        takenAt: true,
        createdAt: true,
        bibs: {
          select: {
            confidence: true,
          },
          orderBy: {
            confidence: 'desc',
          },
          take: 1, // Get highest confidence bib for sorting
        },
        faces: {
          select: {
            confidence: true,
          },
          orderBy: {
            confidence: 'desc',
          },
          take: 1, // Get highest confidence face for sorting
        },
      },
      orderBy: [
        { takenAt: 'desc' },
        { id: 'desc' },
      ],
      take: limitNum + 1, // Take one extra to determine if there are more results
    });

    // Check if there are more results
    const hasMore = photos.length > limitNum;
    const results = hasMore ? photos.slice(0, limitNum) : photos;

    // Transform to response format - only watermark URLs
    const items: PhotoSearchResult[] = results.map(photo => {
      // Use highest confidence from either bibs or faces for sorting
      let confidence = 0;
      if (photo.bibs.length > 0) {
        confidence = Number(photo.bibs[0].confidence);
      } else if (photo.faces.length > 0) {
        confidence = Number(photo.faces[0].confidence);
      }

      return {
        photoId: photo.id,
        watermarkUrl: photo.watermarkUrl!,
        thumbUrl: '',
        originalUrl: '',
        confidence,
        takenAt: photo.takenAt?.toISOString() || photo.createdAt.toISOString(),
      };
    });

    // Generate next cursor
    let nextCursor;
    if (hasMore && results.length > 0) {
      const lastItem = results[results.length - 1];
      const cursorData = {
        takenAt: lastItem.takenAt?.toISOString() || lastItem.createdAt.toISOString(),
        photoId: lastItem.id,
      };
      nextCursor = Buffer.from(JSON.stringify(cursorData)).toString('base64');
    }

    // Get total count of processed photos with watermark
    const totalCount = await this.prisma.photo.count({
      where: {
        eventId,
        status: 'PROCESSED',
        watermarkUrl: { not: null },
      },
    });

    return {
      items,
      nextCursor,
      total: totalCount,
    };
  }

  private async searchPhotosByBibAndType(
    eventId: string,
    bib: string,
    type: 'original' | 'watermark' | 'thumb',
    limit: number = PAGINATION.DEFAULT_LIMIT,
    cursor?: string,
  ): Promise<SearchResponse> {
    // Validate event exists
    const event = await this.prisma.event.findUnique({
      where: { id: eventId },
      select: { id: true, name: true },
    });

    if (!event) {
      throw new NotFoundException({
        code: ERROR_CODES.EVENT_NOT_FOUND,
        message: 'Evento no encontrado',
      });
    }

    // Validate bib format
    if (!bib || bib.trim().length === 0) {
      throw new BadRequestException({
        code: ERROR_CODES.INVALID_BIB_FORMAT,
        message: 'Formato de dorsal inválido',
      });
    }

    const normalizedBib = bib.trim();
    const limitNum = Math.min(limit, PAGINATION.MAX_LIMIT);

    // Build cursor-based pagination
    let cursorCondition = {};
    if (cursor) {
      try {
        const decodedCursor = JSON.parse(Buffer.from(cursor, 'base64').toString());
        cursorCondition = {
          OR: [
            {
              confidence: { lt: decodedCursor.confidence },
            },
            {
              confidence: decodedCursor.confidence,
              photo: {
                takenAt: { lt: new Date(decodedCursor.takenAt) },
              },
            },
            {
              confidence: decodedCursor.confidence,
              photo: {
                takenAt: new Date(decodedCursor.takenAt),
                id: { lt: decodedCursor.photoId },
              },
            },
          ],
        };
      } catch (error) {
        throw new BadRequestException({
          code: ERROR_CODES.VALIDATION_ERROR,
          message: 'Cursor inválido',
        });
      }
    }

    // Build photo conditions based on type
    let photoConditions: any = {
      status: 'PROCESSED',
    };

    switch (type) {
      case 'original':
        photoConditions.originalUrl = { not: null };
        break;
      case 'watermark':
        photoConditions.watermarkUrl = { not: null };
        break;
      case 'thumb':
        photoConditions.thumbUrl = { not: null };
        break;
    }

    // Search for photos with matching bibs
    const photoBibs = await this.prisma.photoBib.findMany({
      where: {
        eventId,
        bib: normalizedBib,
        photo: photoConditions,
        ...cursorCondition,
      },
      include: {
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
      orderBy: [
        { confidence: 'desc' },
        { photo: { takenAt: 'desc' } },
        { photo: { id: 'desc' } },
      ],
      take: limitNum + 1, // Take one extra to determine if there are more results
    });

    // Check if there are more results
    const hasMore = photoBibs.length > limitNum;
    const results = hasMore ? photoBibs.slice(0, limitNum) : photoBibs;

    // Transform to response format based on type - ONLY return the specific type requested
    const items: PhotoSearchResult[] = results.map(photoBib => {
      const baseItem = {
        photoId: photoBib.photo.id,
        confidence: Number(photoBib.confidence),
        takenAt: photoBib.photo.takenAt?.toISOString() || photoBib.photo.createdAt.toISOString(),
      };

      // Return only the requested type URL for security
      switch (type) {
        case 'original':
          return { 
            ...baseItem, 
            originalUrl: photoBib.photo.originalUrl!,
            thumbUrl: '', // Empty other URLs
            watermarkUrl: '',
          };
        case 'watermark':
          return { 
            ...baseItem,
            watermarkUrl: photoBib.photo.watermarkUrl!,
            thumbUrl: '', // Empty other URLs
            originalUrl: '',
          };
        case 'thumb':
          return { 
            ...baseItem,
            thumbUrl: photoBib.photo.thumbUrl!,
            watermarkUrl: '', // Empty other URLs
            originalUrl: '',
          };
        default:
          return {
            ...baseItem,
            thumbUrl: photoBib.photo.thumbUrl || '',
            watermarkUrl: photoBib.photo.watermarkUrl || '',
            originalUrl: photoBib.photo.originalUrl || '',
          };
      }
    });

    // Generate next cursor
    let nextCursor;
    if (hasMore && results.length > 0) {
      const lastItem = results[results.length - 1];
      const cursorData = {
        confidence: Number(lastItem.confidence),
        takenAt: lastItem.photo.takenAt?.toISOString() || lastItem.photo.createdAt.toISOString(),
        photoId: lastItem.photo.id,
      };
      nextCursor = Buffer.from(JSON.stringify(cursorData)).toString('base64');
    }

    // Get total count for this bib (for analytics)
    const totalCount = await this.prisma.photoBib.count({
      where: {
        eventId,
        bib: normalizedBib,
        photo: photoConditions,
      },
    });

    return {
      items,
      nextCursor,
      total: totalCount,
    };
  }
}