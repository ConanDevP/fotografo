import { Injectable, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/services/prisma.service';
import { UserRole } from '@shared/types';
import { ERROR_CODES } from '@shared/constants';

@Injectable()
export class AdminEventsService {
  constructor(private prisma: PrismaService) {}

  async getAllEvents(
    userRole: UserRole,
    page = 1,
    limit = 20,
    filters?: {
      ownerId?: string;
      includeDeleted?: boolean;
      search?: string;
      dateFrom?: string;
      dateTo?: string;
    }
  ) {
    if (userRole !== UserRole.ADMIN) {
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'Solo administradores pueden listar todos los eventos',
      });
    }

    const skip = (page - 1) * limit;
    const where: any = {};

    if (!filters?.includeDeleted) {
      where.deletedAt = null;
    }

    if (filters?.ownerId) {
      where.ownerId = filters.ownerId;
    }

    if (filters?.search) {
      where.OR = [
        { name: { contains: filters.search, mode: 'insensitive' } },
        { slug: { contains: filters.search, mode: 'insensitive' } },
        { location: { contains: filters.search, mode: 'insensitive' } },
      ];
    }

    if (filters?.dateFrom || filters?.dateTo) {
      where.date = {};
      if (filters?.dateFrom) {
        where.date.gte = new Date(filters.dateFrom);
      }
      if (filters?.dateTo) {
        where.date.lte = new Date(filters.dateTo);
      }
    }

    const [events, total] = await Promise.all([
      this.prisma.event.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          owner: {
            select: {
              id: true,
              email: true,
              name: true,
              slug: true,
            },
          },
          _count: {
            select: {
              photos: true,
              orders: true,
              bibSubscriptions: true,
            },
          },
        },
      }),
      this.prisma.event.count({ where }),
    ]);

    return {
      items: events,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }

  async getDeletedEvents(userRole: UserRole, page = 1, limit = 20) {
    if (userRole !== UserRole.ADMIN) {
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'Solo administradores pueden ver eventos eliminados',
      });
    }

    const skip = (page - 1) * limit;

    const [events, total] = await Promise.all([
      this.prisma.event.findMany({
        where: {
          deletedAt: { not: null },
        },
        skip,
        take: limit,
        orderBy: { deletedAt: 'desc' },
        include: {
          owner: {
            select: {
              id: true,
              email: true,
              name: true,
            },
          },
          _count: {
            select: {
              photos: true,
              orders: true,
            },
          },
        },
      }),
      this.prisma.event.count({
        where: { deletedAt: { not: null } },
      }),
    ]);

    return {
      items: events,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }

  async getEventById(eventId: string, userRole: UserRole) {
    if (userRole !== UserRole.ADMIN) {
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'Solo administradores pueden ver detalles de eventos',
      });
    }

    const event = await this.prisma.event.findUnique({
      where: { id: eventId },
      include: {
        owner: {
          select: {
            id: true,
            email: true,
            name: true,
            slug: true,
            phone: true,
          },
        },
        _count: {
          select: {
            photos: true,
            photoBibs: true,
            orders: true,
            bibSubscriptions: true,
          },
        },
      },
    });

    if (!event) {
      throw new NotFoundException({
        code: ERROR_CODES.EVENT_NOT_FOUND,
        message: 'Evento no encontrado',
      });
    }

    return event;
  }

  async updateEvent(eventId: string, updateData: any, userRole: UserRole) {
    if (userRole !== UserRole.ADMIN) {
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'Solo administradores pueden actualizar eventos',
      });
    }

    const event = await this.prisma.event.findUnique({
      where: { id: eventId },
    });

    if (!event) {
      throw new NotFoundException({
        code: ERROR_CODES.EVENT_NOT_FOUND,
        message: 'Evento no encontrado',
      });
    }

    const updatedEvent = await this.prisma.event.update({
      where: { id: eventId },
      data: updateData,
      include: {
        owner: {
          select: {
            email: true,
            name: true,
          },
        },
      },
    });

    return updatedEvent;
  }

  async deleteEventPermanently(eventId: string, userRole: UserRole) {
    if (userRole !== UserRole.ADMIN) {
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'Solo administradores pueden eliminar eventos permanentemente',
      });
    }

    const event = await this.prisma.event.findUnique({
      where: { id: eventId },
      include: {
        _count: {
          select: {
            photos: true,
            orders: true,
          },
        },
      },
    });

    if (!event) {
      throw new NotFoundException({
        code: ERROR_CODES.EVENT_NOT_FOUND,
        message: 'Evento no encontrado',
      });
    }

    // Note: This will cascade delete photos, bibs, subscriptions, etc.
    await this.prisma.event.delete({
      where: { id: eventId },
    });

    // Log the action
    await this.prisma.auditLog.create({
      data: {
        action: 'EVENT_DELETED_PERMANENTLY',
        data: {
          eventId,
          eventName: event.name,
          photosCount: event._count.photos,
          ordersCount: event._count.orders,
        },
      },
    });

    return {
      message: 'Evento eliminado permanentemente',
      deletedPhotos: event._count.photos,
      deletedOrders: event._count.orders,
    };
  }

  async restoreEvent(eventId: string, userRole: UserRole) {
    if (userRole !== UserRole.ADMIN) {
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'Solo administradores pueden restaurar eventos',
      });
    }

    const event = await this.prisma.event.findUnique({
      where: { id: eventId },
    });

    if (!event) {
      throw new NotFoundException({
        code: ERROR_CODES.EVENT_NOT_FOUND,
        message: 'Evento no encontrado',
      });
    }

    if (!event.deletedAt) {
      throw new ForbiddenException({
        code: ERROR_CODES.EVENT_NOT_DELETED,
        message: 'El evento no está eliminado',
      });
    }

    const restoredEvent = await this.prisma.event.update({
      where: { id: eventId },
      data: { deletedAt: null },
    });

    return restoredEvent;
  }

  async getEventsStats(userRole: UserRole) {
    if (userRole !== UserRole.ADMIN) {
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'Solo administradores pueden ver estadísticas de eventos',
      });
    }

    const [
      totalEvents,
      activeEvents,
      deletedEvents,
      recentEvents,
      eventsWithOrders,
    ] = await Promise.all([
      this.prisma.event.count(),
      this.prisma.event.count({ where: { deletedAt: null } }),
      this.prisma.event.count({ where: { deletedAt: { not: null } } }),
      this.prisma.event.count({
        where: {
          createdAt: {
            gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), // Last 30 days
          },
        },
      }),
      this.prisma.event.count({
        where: {
          orders: {
            some: {
              status: 'PAID',
            },
          },
        },
      }),
    ]);

    return {
      total: totalEvents,
      active: activeEvents,
      deleted: deletedEvents,
      recent: recentEvents,
      withOrders: eventsWithOrders,
    };
  }

  async reassignEventOwner(eventId: string, newOwnerId: string, userRole: UserRole) {
    if (userRole !== UserRole.ADMIN) {
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'Solo administradores pueden reasignar eventos',
      });
    }

    const [event, newOwner] = await Promise.all([
      this.prisma.event.findUnique({ where: { id: eventId } }),
      this.prisma.user.findUnique({ where: { id: newOwnerId } }),
    ]);

    if (!event) {
      throw new NotFoundException({
        code: ERROR_CODES.EVENT_NOT_FOUND,
        message: 'Evento no encontrado',
      });
    }

    if (!newOwner) {
      throw new NotFoundException({
        code: ERROR_CODES.USER_NOT_FOUND,
        message: 'Nuevo propietario no encontrado',
      });
    }

    const updatedEvent = await this.prisma.event.update({
      where: { id: eventId },
      data: { ownerId: newOwnerId },
      include: {
        owner: {
          select: {
            id: true,
            email: true,
            name: true,
          },
        },
      },
    });

    // Log the action
    await this.prisma.auditLog.create({
      data: {
        action: 'EVENT_OWNER_REASSIGNED',
        data: {
          eventId,
          oldOwnerId: event.ownerId,
          newOwnerId,
        },
      },
    });

    return updatedEvent;
  }

  async updateFreeDownloadSettings(
    eventId: string,
    settings: {
      isFreeDownload: boolean;
      freeDownloadUntil?: string;
      requireEmailForFree?: boolean;
      freeDownloadLimit?: number;
    },
    userRole: UserRole,
  ) {
    if (userRole !== UserRole.ADMIN) {
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'Solo administradores pueden modificar configuración de descargas gratuitas',
      });
    }

    const event = await this.prisma.event.findUnique({
      where: { id: eventId },
    });

    if (!event) {
      throw new NotFoundException({
        code: ERROR_CODES.EVENT_NOT_FOUND,
        message: 'Evento no encontrado',
      });
    }

    const updatedEvent = await this.prisma.event.update({
      where: { id: eventId },
      data: {
        isFreeDownload: settings.isFreeDownload,
        freeDownloadUntil: settings.freeDownloadUntil ? new Date(settings.freeDownloadUntil) : null,
        requireEmailForFree: settings.requireEmailForFree !== undefined ? settings.requireEmailForFree : true,
        freeDownloadLimit: settings.freeDownloadLimit || null,
      },
    });

    await this.prisma.auditLog.create({
      data: {
        action: 'EVENT_FREE_DOWNLOAD_UPDATED',
        data: {
          eventId,
          settings,
        },
      },
    });

    return updatedEvent;
  }
}
