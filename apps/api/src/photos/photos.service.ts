import { BadRequestException, Injectable, Logger, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../common/services/prisma.service';
import { QueueService } from '../common/services/queue.service';
import { BillingService } from '../billing/billing.service';
import { StorageService } from '../common/services/storage.service';
import { UserRole } from '@shared/types';
import { ERROR_CODES } from '@shared/constants';

@Injectable()
export class PhotosService {
  private readonly logger = new Logger(PhotosService.name);

  constructor(
    private prisma: PrismaService,
    private queueService: QueueService,
    private storageService: StorageService,
    private billingService: BillingService,
  ) {}

  async findOne(id: string, userId: string, userRole: UserRole) {
    const photo = await this.prisma.photo.findUnique({
      where: { id },
      include: {
        event: {
          select: {
            id: true,
            name: true,
            ownerId: true,
            bibRules: true,
            workspace: {
              select: {
                members: {
                  where: { userId, status: 'ACTIVE', role: { in: ['OWNER', 'ADMIN', 'EDITOR'] } },
                  select: { role: true },
                },
              },
            },
            contributors: {
              where: { userId, status: 'ACCEPTED', role: { in: ['EDITOR', 'EVENT_MANAGER'] } },
              select: { role: true },
            },
          },
        },
        photographer: {
          select: { id: true, email: true },
        },
        bibs: {
          select: {
            bib: true,
            confidence: true,
            bbox: true,
            source: true,
            // Omitimos id (BigInt) para evitar error de serialización
          },
        },
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
      photo.event.ownerId === userId ||
      Boolean(photo.event.workspace?.members.length) ||
      Boolean(photo.event.contributors.length);

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

    // Update status to PENDING
    await this.prisma.photo.update({
      where: { id: photoId },
      data: {
        status: 'PENDING',
        processingCompletedAt: null,
        ocrProcessedAt: null,
        ocrFailedAt: null,
        faceProcessedAt: null,
        faceFailedAt: null,
        watermarkFailedAt: null,
      },
    });
    await this.prisma.batchUploadItem.updateMany({
      where: { photoId },
      data: {
        status: 'PROCESSING',
        ocrProcessedAt: null,
        ocrFailedAt: null,
        faceProcessedAt: null,
        faceFailedAt: null,
        watermarkFailedAt: null,
        error: null,
      },
    });

    await this.queueService.addProcessPhotoJob({
      photoId: photo.id,
      eventId: photo.eventId,
      objectKey: photo.cloudinaryId,
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
    const normalizedBib = bib.trim();
    if (!this.matchesBibRules(normalizedBib, photo.event.bibRules)) {
      throw new BadRequestException('El dorsal no cumple las reglas configuradas para el evento');
    }

    // Create or update manual bib
    const existingBib = await this.prisma.photoBib.findFirst({
      where: {
        photoId,
        bib: normalizedBib,
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
          bib: normalizedBib,
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
          bib: normalizedBib,
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
    let parsedBibId: bigint;
    try {
      parsedBibId = BigInt(bibId);
    } catch {
      throw new BadRequestException('Identificador de dorsal inválido');
    }
    const bib = await this.prisma.photoBib.findUnique({
      where: { id: parsedBibId },
    });

    if (!bib || bib.photoId !== photoId) {
      throw new NotFoundException({
        code: ERROR_CODES.BIB_NOT_FOUND,
        message: 'Dorsal no encontrado',
      });
    }

    await this.prisma.photoBib.delete({
      where: { id: parsedBibId },
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

    // Keep database state authoritative. If object cleanup fails, the private
    // orphan can be retried later without leaving a visible broken photo row.
    await this.prisma.photo.delete({ where: { id: photoId } });

    // Devolver el cupo aunque el borrado en R2 falle: el objeto ya no es
    // accesible y cobrar por él sería incorrecto.
    await this.billingService.releaseStorage(
      photo.photographerWorkspaceId,
      (photo.originalBytes ?? 0) + (photo.derivedBytes ?? 0),
    );

    try {
      await this.storageService.deletePhoto(photo.cloudinaryId);
    } catch {
      await this.prisma.auditLog.create({
        data: {
          userId,
          action: 'PHOTO_STORAGE_CLEANUP_REQUIRED',
          data: { deletedPhotoId: photoId, objectKey: photo.cloudinaryId },
        },
      }).catch(() => undefined);
      this.logger.warn(`La foto ${photoId} se eliminó de la base, pero el objeto privado quedó pendiente de limpieza`);
    }

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

  private matchesBibRules(bib: string, rawRules: unknown) {
    if (!/^\d{1,20}$/.test(bib)) return false;
    if (!rawRules || typeof rawRules !== 'object' || Array.isArray(rawRules)) return true;
    const rules = rawRules as Record<string, any>;
    if (rules.minLen && bib.length < rules.minLen) return false;
    if (rules.maxLen && bib.length > rules.maxLen) return false;
    if (Array.isArray(rules.whitelist) && !rules.whitelist.includes(bib)) return false;
    if (Array.isArray(rules.range) && rules.range.length === 2) {
      const numeric = Number(bib);
      if (!Number.isSafeInteger(numeric) || numeric < rules.range[0] || numeric > rules.range[1]) return false;
    }
    if (rules.regex) {
      const safeNumericPattern = /^(?:\^|\$|\\d|\[|\]|\{|\}|,|-|[0-9])+$/;
      if (typeof rules.regex !== 'string' || !safeNumericPattern.test(rules.regex)) return false;
      try {
        if (!new RegExp(rules.regex).test(bib)) return false;
      } catch {
        return false;
      }
    }
    return true;
  }
}
