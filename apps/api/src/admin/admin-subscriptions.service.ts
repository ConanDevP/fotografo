import { Injectable, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/services/prisma.service';
import { UserRole } from '@shared/types';
import { ERROR_CODES } from '@shared/constants';

@Injectable()
export class AdminSubscriptionsService {
  constructor(private prisma: PrismaService) {}

  async getAllSubscriptions(
    userRole: UserRole,
    page = 1,
    limit = 50,
    filters?: {
      eventId?: string;
      email?: string;
      bib?: string;
      dateFrom?: string;
      dateTo?: string;
    }
  ) {
    if (userRole !== UserRole.ADMIN) {
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'Solo administradores pueden listar suscripciones',
      });
    }

    const skip = (page - 1) * limit;
    const where: any = {};

    if (filters?.eventId) {
      where.eventId = filters.eventId;
    }

    if (filters?.email) {
      where.email = { contains: filters.email, mode: 'insensitive' };
    }

    if (filters?.bib) {
      where.bib = filters.bib;
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

    const [subscriptions, total] = await Promise.all([
      this.prisma.bibSubscription.findMany({
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
              date: true,
            },
          },
        },
      }),
      this.prisma.bibSubscription.count({ where }),
    ]);

    return {
      items: subscriptions,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }

  async getSubscriptionsByEvent(eventId: string, userRole: UserRole, page = 1, limit = 50) {
    if (userRole !== UserRole.ADMIN) {
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'Solo administradores pueden ver suscripciones por evento',
      });
    }

    const skip = (page - 1) * limit;

    const [subscriptions, total] = await Promise.all([
      this.prisma.bibSubscription.findMany({
        where: { eventId },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.bibSubscription.count({ where: { eventId } }),
    ]);

    return {
      items: subscriptions,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }

  async getSubscriptionById(subscriptionId: string, userRole: UserRole) {
    if (userRole !== UserRole.ADMIN) {
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'Solo administradores pueden ver detalles de suscripciones',
      });
    }

    const subscription = await this.prisma.bibSubscription.findUnique({
      where: { id: subscriptionId },
      include: {
        event: {
          select: {
            id: true,
            name: true,
            slug: true,
            date: true,
            location: true,
          },
        },
      },
    });

    if (!subscription) {
      throw new NotFoundException({
        code: ERROR_CODES.SUBSCRIPTION_NOT_FOUND,
        message: 'Suscripción no encontrada',
      });
    }

    return subscription;
  }

  async deleteSubscription(subscriptionId: string, userRole: UserRole) {
    if (userRole !== UserRole.ADMIN) {
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'Solo administradores pueden eliminar suscripciones',
      });
    }

    const subscription = await this.prisma.bibSubscription.findUnique({
      where: { id: subscriptionId },
    });

    if (!subscription) {
      throw new NotFoundException({
        code: ERROR_CODES.SUBSCRIPTION_NOT_FOUND,
        message: 'Suscripción no encontrada',
      });
    }

    await this.prisma.bibSubscription.delete({
      where: { id: subscriptionId },
    });

    return { message: 'Suscripción eliminada correctamente' };
  }

  async getSubscriptionsStats(userRole: UserRole) {
    if (userRole !== UserRole.ADMIN) {
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'Solo administradores pueden ver estadísticas de suscripciones',
      });
    }

    const [
      totalSubscriptions,
      recentSubscriptions,
      subscriptionsByEvent,
      uniqueEmails,
    ] = await Promise.all([
      this.prisma.bibSubscription.count(),
      this.prisma.bibSubscription.count({
        where: {
          createdAt: {
            gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000), // Last 7 days
          },
        },
      }),
      this.prisma.bibSubscription.groupBy({
        by: ['eventId'],
        _count: { eventId: true },
        orderBy: {
          _count: {
            eventId: 'desc',
          },
        },
        take: 10,
      }),
      this.prisma.bibSubscription.findMany({
        distinct: ['email'],
        select: { email: true },
      }),
    ]);

    return {
      total: totalSubscriptions,
      recent: recentSubscriptions,
      uniqueEmails: uniqueEmails.length,
      topEvents: await Promise.all(
        subscriptionsByEvent.map(async (item) => {
          const event = await this.prisma.event.findUnique({
            where: { id: item.eventId },
            select: { name: true, slug: true },
          });
          return {
            eventId: item.eventId,
            eventName: event?.name,
            eventSlug: event?.slug,
            count: item._count.eventId,
          };
        })
      ),
    };
  }

  async bulkDeleteSubscriptions(subscriptionIds: string[], userRole: UserRole) {
    if (userRole !== UserRole.ADMIN) {
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'Solo administradores pueden eliminar suscripciones en masa',
      });
    }

    const result = await this.prisma.bibSubscription.deleteMany({
      where: {
        id: { in: subscriptionIds },
      },
    });

    return {
      message: `${result.count} suscripciones eliminadas`,
      deletedCount: result.count,
    };
  }
}
