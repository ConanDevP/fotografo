import { Injectable, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/services/prisma.service';
import { CloudinaryService } from '../common/services/cloudinary.service';
import { QueueService } from '../common/services/queue.service';
import { UserRole } from '@shared/types';
import { ERROR_CODES } from '@shared/constants';

@Injectable()
export class AdminService {
  constructor(
    private prisma: PrismaService,
    private cloudinaryService: CloudinaryService,
    private queueService: QueueService,
  ) {}

  async getEventMetrics(eventId: string, userRole: UserRole, userId: string) {
    // Check permissions
    const event = await this.prisma.event.findUnique({
      where: { id: eventId },
      select: { ownerId: true },
    });

    if (!event) {
      throw new NotFoundException({
        code: ERROR_CODES.EVENT_NOT_FOUND,
        message: 'Evento no encontrado',
      });
    }

    if (userRole !== UserRole.ADMIN && event.ownerId !== userId) {
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'No tienes permisos para ver métricas de este evento',
      });
    }

    // Get comprehensive metrics
    const [
      totalPhotos,
      processedPhotos,
      failedPhotos,
      totalBibs,
      uniqueBibs,
      totalOrders,
      paidOrders,
      totalRevenue,
      subscriptions,
      ocrAccuracy,
    ] = await Promise.all([
      // Photo counts
      this.prisma.photo.count({ where: { eventId } }),
      this.prisma.photo.count({ where: { eventId, status: 'PROCESSED' } }),
      this.prisma.photo.count({ where: { eventId, status: 'FAILED' } }),
      
      // Bib statistics
      this.prisma.photoBib.count({ where: { eventId } }),
      this.prisma.photoBib.groupBy({
        by: ['bib'],
        where: { eventId },
        _count: { bib: true },
      }).then(result => result.length),
      
      // Order statistics
      this.prisma.order.count({ where: { eventId } }),
      this.prisma.order.count({ where: { eventId, status: 'PAID' } }),
      this.prisma.order.aggregate({
        where: { eventId, status: 'PAID' },
        _sum: { amountCents: true },
      }).then(result => result._sum.amountCents || 0),
      
      // Subscriptions
      this.prisma.bibSubscription.count({ where: { eventId } }),
      
      // OCR accuracy (photos with at least one detected bib / total processed photos)
      this.getOcrAccuracy(eventId),
    ]);

    return {
      eventId,
      photos: {
        total: totalPhotos,
        processed: processedPhotos,
        failed: failedPhotos,
        pending: totalPhotos - processedPhotos - failedPhotos,
        processingRate: totalPhotos > 0 ? (processedPhotos / totalPhotos * 100) : 0,
      },
      bibs: {
        total: totalBibs,
        unique: uniqueBibs,
        avgBibsPerPhoto: processedPhotos > 0 ? (totalBibs / processedPhotos) : 0,
      },
      orders: {
        total: totalOrders,
        paid: paidOrders,
        conversionRate: totalOrders > 0 ? (paidOrders / totalOrders * 100) : 0,
      },
      revenue: {
        totalCents: totalRevenue,
        avgOrderValue: paidOrders > 0 ? (totalRevenue / paidOrders) : 0,
      },
      subscriptions: {
        total: subscriptions,
      },
      ocr: {
        accuracy: ocrAccuracy,
      },
    };
  }

  private async getOcrAccuracy(eventId: string): Promise<number> {
    const [photosWithBibs, totalProcessed] = await Promise.all([
      this.prisma.photo.count({
        where: {
          eventId,
          status: 'PROCESSED',
          bibs: {
            some: {},
          },
        },
      }),
      this.prisma.photo.count({
        where: {
          eventId,
          status: 'PROCESSED',
        },
      }),
    ]);

    return totalProcessed > 0 ? (photosWithBibs / totalProcessed * 100) : 0;
  }

  async getTopBibs(eventId: string, userRole: UserRole, userId: string, limit = 20) {
    // Check permissions (same as getEventMetrics)
    const event = await this.prisma.event.findUnique({
      where: { id: eventId },
      select: { ownerId: true },
    });

    if (!event) {
      throw new NotFoundException({
        code: ERROR_CODES.EVENT_NOT_FOUND,
        message: 'Evento no encontrado',
      });
    }

    if (userRole !== UserRole.ADMIN && event.ownerId !== userId) {
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'No tienes permisos para ver datos de este evento',
      });
    }

    const topBibs = await this.prisma.photoBib.groupBy({
      by: ['bib'],
      where: { eventId },
      _count: {
        bib: true,
      },
      _avg: {
        confidence: true,
      },
      orderBy: {
        _count: {
          bib: 'desc',
        },
      },
      take: limit,
    });

    // Get order statistics for each bib
    const bibsWithOrders = await Promise.all(
      topBibs.map(async (bib) => {
        const orders = await this.prisma.order.count({
          where: {
            eventId,
            status: 'PAID',
            items: {
              some: {
                photo: {
                  bibs: {
                    some: { bib: bib.bib },
                  },
                },
              },
            },
          },
        });

        return {
          bib: bib.bib,
          photoCount: bib._count.bib,
          avgConfidence: bib._avg.confidence ? Number(bib._avg.confidence) : 0,
          orders,
        };
      })
    );

    return bibsWithOrders;
  }

  async reprocessPhoto(photoId: string, strategy: 'flash' | 'pro' = 'pro', userRole: UserRole) {
    if (userRole !== UserRole.ADMIN) {
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'Solo administradores pueden reprocesar fotos',
      });
    }

    const photo = await this.prisma.photo.findUnique({
      where: { id: photoId },
      select: { id: true, eventId: true },
    });

    if (!photo) {
      throw new NotFoundException({
        code: ERROR_CODES.PHOTO_NOT_FOUND,
        message: 'Foto no encontrada',
      });
    }

    // Add to reprocess queue
    await this.queueService.addReprocessPhotoJob({
      photoId,
      strategy,
    });

    // Log the action
    await this.prisma.auditLog.create({
      data: {
        photoId,
        action: 'REPROCESS_TRIGGERED',
        data: { strategy },
      },
    });

    return { message: 'Reprocesamiento iniciado', strategy };
  }

  async getQueueStats(userRole: UserRole) {
    if (userRole !== UserRole.ADMIN) {
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'Solo administradores pueden ver estadísticas de colas',
      });
    }

    const [processPhotoStats, emailStats] = await Promise.all([
      this.queueService.getProcessPhotoQueueStats(),
      this.queueService.getEmailQueueStats(),
    ]);

    return {
      processPhoto: {
        waiting: processPhotoStats.waiting.length,
        active: processPhotoStats.active.length,
        completed: processPhotoStats.completed.length,
        failed: processPhotoStats.failed.length,
      },
      email: {
        waiting: emailStats.waiting.length,
        active: emailStats.active.length,
        completed: emailStats.completed.length,
        failed: emailStats.failed.length,
      },
    };
  }

  async getSystemStats(userRole: UserRole) {
    if (userRole !== UserRole.ADMIN) {
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'Solo administradores pueden ver estadísticas del sistema',
      });
    }

    const [
      totalUsers,
      totalEvents,
      totalPhotos,
      totalOrders,
      totalRevenue,
      recentActivity,
    ] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.event.count(),
      this.prisma.photo.count(),
      this.prisma.order.count({ where: { status: 'PAID' } }),
      this.prisma.order.aggregate({
        where: { status: 'PAID' },
        _sum: { amountCents: true },
      }).then(result => result._sum.amountCents || 0),
      
      // Recent activity (last 24 hours)
      this.prisma.photo.count({
        where: {
          createdAt: {
            gte: new Date(Date.now() - 24 * 60 * 60 * 1000),
          },
        },
      }),
    ]);

    return {
      users: { total: totalUsers },
      events: { total: totalEvents },
      photos: { 
        total: totalPhotos,
        recentUploads: recentActivity,
      },
      orders: { total: totalOrders },
      revenue: { totalCents: totalRevenue },
    };
  }

  async getAuditLogs(
    photoId?: string,
    userId?: string,
    page = 1,
    limit = 50,
    userRole: UserRole = UserRole.ADMIN,
  ) {
    if (userRole !== UserRole.ADMIN) {
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'Solo administradores pueden ver logs de auditoría',
      });
    }

    const skip = (page - 1) * limit;
    const where: any = {};
    
    if (photoId) where.photoId = photoId;
    if (userId) where.userId = userId;

    const [logs, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          user: {
            select: { email: true, role: true },
          },
          photo: {
            select: { eventId: true },
          },
        },
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    return {
      items: logs,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }
}