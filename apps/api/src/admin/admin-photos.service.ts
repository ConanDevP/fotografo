import { Injectable, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/services/prisma.service';
import { CloudinaryService } from '../common/services/cloudinary.service';
import { UserRole } from '@shared/types';
import { ERROR_CODES } from '@shared/constants';

@Injectable()
export class AdminPhotosService {
  constructor(
    private prisma: PrismaService,
    private cloudinaryService: CloudinaryService,
  ) {}

  async getAllPhotos(
    userRole: UserRole,
    page = 1,
    limit = 50,
    filters?: {
      status?: string;
      eventId?: string;
      photographerId?: string;
      dateFrom?: string;
      dateTo?: string;
    }
  ) {
    if (userRole !== UserRole.ADMIN) {
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'Solo administradores pueden listar todas las fotos',
      });
    }

    const skip = (page - 1) * limit;
    const where: any = {};

    if (filters?.status) {
      where.status = filters.status;
    }

    if (filters?.eventId) {
      where.eventId = filters.eventId;
    }

    if (filters?.photographerId) {
      where.photographerId = filters.photographerId;
    }

    if (filters?.dateFrom || filters?.dateTo) {
      where.createdAt = {};
      if (filters?.dateFrom) {
        where.createdAt.gte = new Date(filters.dateFrom);
      }
      if (filters?.dateTo) {
        where.createdAt.lte = new Date(filters.dateTo);
      }
    }

    const [photos, total] = await Promise.all([
      this.prisma.photo.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          event: {
            select: {
              id: true,
              name: true,
              slug: true,
            },
          },
          photographer: {
            select: {
              id: true,
              email: true,
              name: true,
            },
          },
          _count: {
            select: {
              bibs: true,
              faces: true,
              orderItems: true,
            },
          },
        },
      }),
      this.prisma.photo.count({ where }),
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

  async getFailedPhotos(userRole: UserRole, page = 1, limit = 50) {
    if (userRole !== UserRole.ADMIN) {
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'Solo administradores pueden ver fotos fallidas',
      });
    }

    const skip = (page - 1) * limit;

    const [photos, total] = await Promise.all([
      this.prisma.photo.findMany({
        where: { status: 'FAILED' },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          event: {
            select: {
              id: true,
              name: true,
            },
          },
          photographer: {
            select: {
              id: true,
              email: true,
            },
          },
          auditLogs: {
            where: {
              action: { contains: 'FAIL' },
            },
            orderBy: { createdAt: 'desc' },
            take: 1,
          },
        },
      }),
      this.prisma.photo.count({ where: { status: 'FAILED' } }),
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

  async getPhotoById(photoId: string, userRole: UserRole) {
    if (userRole !== UserRole.ADMIN) {
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'Solo administradores pueden ver detalles de fotos',
      });
    }

    const photo = await this.prisma.photo.findUnique({
      where: { id: photoId },
      include: {
        event: {
          select: {
            id: true,
            name: true,
            slug: true,
            date: true,
          },
        },
        photographer: {
          select: {
            id: true,
            email: true,
            name: true,
          },
        },
        bibs: {
          orderBy: { confidence: 'desc' },
        },
        faces: {
          select: {
            id: true,
            confidence: true,
            age: true,
            gender: true,
            bbox: true,
          },
        },
        orderItems: {
          include: {
            order: {
              select: {
                id: true,
                status: true,
                amountCents: true,
              },
            },
          },
        },
        auditLogs: {
          orderBy: { createdAt: 'desc' },
          take: 10,
        },
      },
    });

    if (!photo) {
      throw new NotFoundException({
        code: ERROR_CODES.PHOTO_NOT_FOUND,
        message: 'Foto no encontrada',
      });
    }

    return photo;
  }

  async updatePhoto(photoId: string, updateData: any, userRole: UserRole) {
    if (userRole !== UserRole.ADMIN) {
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'Solo administradores pueden actualizar fotos',
      });
    }

    const photo = await this.prisma.photo.findUnique({
      where: { id: photoId },
    });

    if (!photo) {
      throw new NotFoundException({
        code: ERROR_CODES.PHOTO_NOT_FOUND,
        message: 'Foto no encontrada',
      });
    }

    const updatedPhoto = await this.prisma.photo.update({
      where: { id: photoId },
      data: updateData,
    });

    return updatedPhoto;
  }

  async reassignPhoto(
    photoId: string,
    newEventId?: string,
    newPhotographerId?: string,
    userRole?: UserRole,
  ) {
    if (userRole !== UserRole.ADMIN) {
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'Solo administradores pueden reasignar fotos',
      });
    }

    const photo = await this.prisma.photo.findUnique({
      where: { id: photoId },
    });

    if (!photo) {
      throw new NotFoundException({
        code: ERROR_CODES.PHOTO_NOT_FOUND,
        message: 'Foto no encontrada',
      });
    }

    const updateData: any = {};
    if (newEventId) updateData.eventId = newEventId;
    if (newPhotographerId) updateData.photographerId = newPhotographerId;

    const updatedPhoto = await this.prisma.photo.update({
      where: { id: photoId },
      data: updateData,
      include: {
        event: {
          select: {
            name: true,
          },
        },
        photographer: {
          select: {
            name: true,
          },
        },
      },
    });

    // Log the action
    await this.prisma.auditLog.create({
      data: {
        photoId,
        action: 'PHOTO_REASSIGNED',
        data: {
          oldEventId: photo.eventId,
          newEventId,
          oldPhotographerId: photo.photographerId,
          newPhotographerId,
        },
      },
    });

    return updatedPhoto;
  }

  async deletePhotoPermanently(photoId: string, userRole: UserRole) {
    if (userRole !== UserRole.ADMIN) {
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'Solo administradores pueden eliminar fotos permanentemente',
      });
    }

    const photo = await this.prisma.photo.findUnique({
      where: { id: photoId },
      include: {
        orderItems: true,
      },
    });

    if (!photo) {
      throw new NotFoundException({
        code: ERROR_CODES.PHOTO_NOT_FOUND,
        message: 'Foto no encontrada',
      });
    }

    // Delete from Cloudinary
    try {
      await this.cloudinaryService.deleteImage(photo.cloudinaryId);
    } catch (error) {
      console.error('Error deleting from Cloudinary:', error);
      // Continue anyway to delete from database
    }

    // Delete from database (will cascade delete bibs, faces, etc.)
    await this.prisma.photo.delete({
      where: { id: photoId },
    });

    // Log the action
    await this.prisma.auditLog.create({
      data: {
        action: 'PHOTO_DELETED_PERMANENTLY',
        data: {
          photoId,
          cloudinaryId: photo.cloudinaryId,
          eventId: photo.eventId,
          orderItemsCount: photo.orderItems.length,
        },
      },
    });

    return {
      message: 'Foto eliminada permanentemente',
      cloudinaryId: photo.cloudinaryId,
    };
  }

  async getPhotosStats(userRole: UserRole) {
    if (userRole !== UserRole.ADMIN) {
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'Solo administradores pueden ver estadísticas de fotos',
      });
    }

    const [totalPhotos, photosByStatus, recentUploads, photosWithOrders] = await Promise.all([
      this.prisma.photo.count(),
      this.prisma.photo.groupBy({
        by: ['status'],
        _count: { status: true },
      }),
      this.prisma.photo.count({
        where: {
          createdAt: {
            gte: new Date(Date.now() - 24 * 60 * 60 * 1000), // Last 24 hours
          },
        },
      }),
      this.prisma.photo.count({
        where: {
          orderItems: {
            some: {},
          },
        },
      }),
    ]);

    const statusStats = photosByStatus.reduce((acc, stat) => {
      acc[stat.status] = stat._count.status;
      return acc;
    }, {} as Record<string, number>);

    return {
      total: totalPhotos,
      byStatus: statusStats,
      recentUploads,
      withOrders: photosWithOrders,
    };
  }

  async bulkDeletePhotos(photoIds: string[], userRole: UserRole) {
    if (userRole !== UserRole.ADMIN) {
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'Solo administradores pueden eliminar fotos en masa',
      });
    }

    const photos = await this.prisma.photo.findMany({
      where: {
        id: { in: photoIds },
      },
      select: {
        id: true,
        cloudinaryId: true,
      },
    });

    // Delete from Cloudinary in parallel
    await Promise.allSettled(
      photos.map(photo => this.cloudinaryService.deleteImage(photo.cloudinaryId))
    );

    // Delete from database
    const result = await this.prisma.photo.deleteMany({
      where: {
        id: { in: photoIds },
      },
    });

    // Log the action
    await this.prisma.auditLog.create({
      data: {
        action: 'PHOTOS_BULK_DELETED',
        data: {
          photoIds,
          count: result.count,
        },
      },
    });

    return {
      message: `${result.count} fotos eliminadas`,
      deletedCount: result.count,
    };
  }
}
