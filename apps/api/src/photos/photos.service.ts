import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../common/services/prisma.service';
import { QueueService } from '../common/services/queue.service';
import { StorageService } from '../common/services/storage.service';
import { UserRole } from '@shared/types';
import { ERROR_CODES } from '@shared/constants';

@Injectable()
export class PhotosService {
  constructor(
    private prisma: PrismaService,
    private queueService: QueueService,
    private storageService: StorageService,
  ) {}

  async findOne(id: string, userId: string, userRole: UserRole) {
    const photo = await this.prisma.photo.findUnique({
      where: { id },
      include: {
        event: {
          select: { id: true, name: true, ownerId: true },
        },
        photographer: {
          select: { id: true, email: true },
        },
        bibs: true,
      },
    });

    if (!photo) {
      throw new NotFoundException({
        code: ERROR_CODES.PHOTO_NOT_FOUND,
        message: 'Foto no encontrada',
      });
    }

    // Check permissions
    const hasPermission = 
      userRole === UserRole.ADMIN ||
      photo.photographerId === userId ||
      photo.event.ownerId === userId;

    if (!hasPermission) {
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'No tienes permisos para ver esta foto',
      });
    }

    return photo;
  }

  async findByEvent(eventId: string, page = 1, limit = 50) {
    const skip = (page - 1) * limit;

    const [photos, total] = await Promise.all([
      this.prisma.photo.findMany({
        where: { eventId },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          photographer: {
            select: { id: true, email: true },
          },
          _count: {
            select: { bibs: true },
          },
        },
      }),
      this.prisma.photo.count({
        where: { eventId },
      }),
    ]);

    return {
      items: photos,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }

  async triggerProcessing(photoId: string, userId: string, userRole: UserRole) {
    const photo = await this.findOne(photoId, userId, userRole);
    
    // Only allow processing of PENDING or FAILED photos
    if (photo.status === 'PROCESSED') {
      throw new ForbiddenException({
        code: ERROR_CODES.VALIDATION_ERROR,
        message: 'La foto ya está procesada',
      });
    }

    // Add to processing queue
    await this.queueService.addProcessPhotoJob({
      photoId: photo.id,
      eventId: photo.eventId,
      objectKey: photo.cloudinaryId,
    });

    // Update status to PENDING
    await this.prisma.photo.update({
      where: { id: photoId },
      data: { status: 'PENDING' },
    });

    return { message: 'Procesamiento iniciado' };
  }

  async addBibCorrection(
    photoId: string,
    bib: string,
    userId: string,
    userRole: UserRole,
    confidence = 1.0,
    bbox?: [number, number, number, number],
  ) {
    const photo = await this.findOne(photoId, userId, userRole);

    // Create or update manual bib
    const existingBib = await this.prisma.photoBib.findFirst({
      where: {
        photoId,
        bib,
        source: 'MANUAL',
      },
    });

    let bibRecord;
    
    if (existingBib) {
      bibRecord = await this.prisma.photoBib.update({
        where: { id: existingBib.id },
        data: {
          confidence,
          bbox,
        },
      });
    } else {
      bibRecord = await this.prisma.photoBib.create({
        data: {
          photoId,
          eventId: photo.eventId,
          bib,
          confidence,
          bbox,
          source: 'MANUAL',
        },
      });
    }

    // Log the correction
    await this.prisma.auditLog.create({
      data: {
        userId,
        photoId,
        action: 'BIB_EDIT',
        data: {
          bib,
          confidence,
          bbox,
          previousValue: existingBib ? {
            confidence: existingBib.confidence,
            bbox: existingBib.bbox,
          } : null,
        },
      },
    });

    return bibRecord;
  }

  async removeBib(photoId: string, bibId: string, userId: string, userRole: UserRole) {
    const photo = await this.findOne(photoId, userId, userRole);
    
    const bib = await this.prisma.photoBib.findUnique({
      where: { id: BigInt(bibId) },
    });

    if (!bib || bib.photoId !== photoId) {
      throw new NotFoundException({
        code: ERROR_CODES.BIB_NOT_FOUND,
        message: 'Dorsal no encontrado',
      });
    }

    await this.prisma.photoBib.delete({
      where: { id: BigInt(bibId) },
    });

    // Log the removal
    await this.prisma.auditLog.create({
      data: {
        userId,
        photoId,
        action: 'BIB_REMOVE',
        data: {
          removedBib: bib.bib,
          confidence: bib.confidence,
          source: bib.source,
        },
      },
    });

    return { message: 'Dorsal eliminado' };
  }

  async delete(photoId: string, userId: string, userRole: UserRole) {
    const photo = await this.findOne(photoId, userId, userRole);

    // Delete from Cloudinary
    try {
      await this.storageService.deletePhoto(photo.cloudinaryId);
    } catch (error) {
      // Log error but continue with database deletion
      console.error('Error deleting from Cloudinary:', error);
    }

    // Delete from database (cascade will handle related records)
    await this.prisma.photo.delete({
      where: { id: photoId },
    });

    return { message: 'Foto eliminada' };
  }

  async generateSecureDownloadUrl(photoId: string, userId: string, userRole: UserRole) {
    const photo = await this.findOne(photoId, userId, userRole);
    
    // Generate secure download URL
    const downloadUrl = await this.storageService.generateSecureDownloadUrl(
      photo.cloudinaryId,
      300, // 5 minutes
    );

    return { downloadUrl };
  }
}