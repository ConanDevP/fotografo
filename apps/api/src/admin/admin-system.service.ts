import { Injectable, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../common/services/prisma.service';
import { QueueService } from '../common/services/queue.service';
import { UserRole } from '@shared/types';
import { ERROR_CODES } from '@shared/constants';

@Injectable()
export class AdminSystemService {
  constructor(
    private prisma: PrismaService,
    private queueService: QueueService,
  ) {}

  async getHealthCheck(userRole: UserRole) {
    if (userRole !== UserRole.ADMIN) {
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'Solo administradores pueden ver el estado del sistema',
      });
    }

    const [dbStatus, queueStatus] = await Promise.all([
      this.checkDatabaseHealth(),
      this.checkQueuesHealth(),
    ]);

    return {
      status: dbStatus.ok && queueStatus.ok ? 'healthy' : 'unhealthy',
      timestamp: new Date().toISOString(),
      checks: {
        database: dbStatus,
        queues: queueStatus,
      },
    };
  }

  private async checkDatabaseHealth() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { ok: true, message: 'Database connected' };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return { ok: false, message: 'Database connection failed', error: errorMessage };
    }
  }

  private async checkQueuesHealth() {
    try {
      const [processPhotoStats, emailStats] = await Promise.all([
        this.queueService.getProcessPhotoQueueStats(),
        this.queueService.getEmailQueueStats(),
      ]);

      return {
        ok: true,
        processPhoto: {
          waiting: processPhotoStats.waiting.length,
          active: processPhotoStats.active.length,
        },
        email: {
          waiting: emailStats.waiting.length,
          active: emailStats.active.length,
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return { ok: false, message: 'Queue connection failed', error: errorMessage };
    }
  }

  async getDailyReport(userRole: UserRole, date?: string) {
    if (userRole !== UserRole.ADMIN) {
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'Solo administradores pueden ver reportes',
      });
    }

    const targetDate = date ? new Date(date) : new Date();
    const startOfDay = new Date(targetDate.setHours(0, 0, 0, 0));
    const endOfDay = new Date(targetDate.setHours(23, 59, 59, 999));

    const [
      newUsers,
      newEvents,
      uploadedPhotos,
      processedPhotos,
      newOrders,
      revenue,
      newSubscriptions,
    ] = await Promise.all([
      this.prisma.user.count({
        where: { createdAt: { gte: startOfDay, lte: endOfDay } },
      }),
      this.prisma.event.count({
        where: { createdAt: { gte: startOfDay, lte: endOfDay } },
      }),
      this.prisma.photo.count({
        where: { createdAt: { gte: startOfDay, lte: endOfDay } },
      }),
      this.prisma.photo.count({
        where: {
          createdAt: { gte: startOfDay, lte: endOfDay },
          status: 'PROCESSED',
        },
      }),
      this.prisma.order.count({
        where: { createdAt: { gte: startOfDay, lte: endOfDay } },
      }),
      this.prisma.order.aggregate({
        where: {
          createdAt: { gte: startOfDay, lte: endOfDay },
          status: 'PAID',
        },
        _sum: { amountCents: true },
      }),
      this.prisma.bibSubscription.count({
        where: { createdAt: { gte: startOfDay, lte: endOfDay } },
      }),
    ]);

    return {
      date: startOfDay.toISOString().split('T')[0],
      users: {
        new: newUsers,
      },
      events: {
        new: newEvents,
      },
      photos: {
        uploaded: uploadedPhotos,
        processed: processedPhotos,
      },
      orders: {
        new: newOrders,
      },
      revenue: {
        totalCents: revenue._sum.amountCents || 0,
      },
      subscriptions: {
        new: newSubscriptions,
      },
    };
  }

  async getMonthlyReport(userRole: UserRole, year: number, month: number) {
    if (userRole !== UserRole.ADMIN) {
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'Solo administradores pueden ver reportes',
      });
    }

    const startOfMonth = new Date(year, month - 1, 1);
    const endOfMonth = new Date(year, month, 0, 23, 59, 59, 999);

    const [
      newUsers,
      newEvents,
      uploadedPhotos,
      processedPhotos,
      totalOrders,
      paidOrders,
      revenue,
      newSubscriptions,
    ] = await Promise.all([
      this.prisma.user.count({
        where: { createdAt: { gte: startOfMonth, lte: endOfMonth } },
      }),
      this.prisma.event.count({
        where: { createdAt: { gte: startOfMonth, lte: endOfMonth } },
      }),
      this.prisma.photo.count({
        where: { createdAt: { gte: startOfMonth, lte: endOfMonth } },
      }),
      this.prisma.photo.count({
        where: {
          createdAt: { gte: startOfMonth, lte: endOfMonth },
          status: 'PROCESSED',
        },
      }),
      this.prisma.order.count({
        where: { createdAt: { gte: startOfMonth, lte: endOfMonth } },
      }),
      this.prisma.order.count({
        where: {
          createdAt: { gte: startOfMonth, lte: endOfMonth },
          status: 'PAID',
        },
      }),
      this.prisma.order.aggregate({
        where: {
          createdAt: { gte: startOfMonth, lte: endOfMonth },
          status: 'PAID',
        },
        _sum: { amountCents: true },
      }),
      this.prisma.bibSubscription.count({
        where: { createdAt: { gte: startOfMonth, lte: endOfMonth } },
      }),
    ]);

    return {
      period: `${year}-${String(month).padStart(2, '0')}`,
      users: {
        new: newUsers,
      },
      events: {
        new: newEvents,
      },
      photos: {
        uploaded: uploadedPhotos,
        processed: processedPhotos,
        processingRate: uploadedPhotos > 0 ? (processedPhotos / uploadedPhotos) * 100 : 0,
      },
      orders: {
        total: totalOrders,
        paid: paidOrders,
        conversionRate: totalOrders > 0 ? (paidOrders / totalOrders) * 100 : 0,
      },
      revenue: {
        totalCents: revenue._sum.amountCents || 0,
        avgOrderValue: paidOrders > 0 ? (revenue._sum.amountCents || 0) / paidOrders : 0,
      },
      subscriptions: {
        new: newSubscriptions,
      },
    };
  }

  async getUsersGrowthReport(userRole: UserRole, months = 12) {
    if (userRole !== UserRole.ADMIN) {
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'Solo administradores pueden ver reportes',
      });
    }

    const reports = [];
    const now = new Date();

    for (let i = months - 1; i >= 0; i--) {
      const targetDate = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const startOfMonth = new Date(targetDate.getFullYear(), targetDate.getMonth(), 1);
      const endOfMonth = new Date(targetDate.getFullYear(), targetDate.getMonth() + 1, 0, 23, 59, 59, 999);

      const [newUsers, totalUsers] = await Promise.all([
        this.prisma.user.count({
          where: { createdAt: { gte: startOfMonth, lte: endOfMonth } },
        }),
        this.prisma.user.count({
          where: { createdAt: { lte: endOfMonth } },
        }),
      ]);

      reports.push({
        period: `${targetDate.getFullYear()}-${String(targetDate.getMonth() + 1).padStart(2, '0')}`,
        newUsers,
        totalUsers,
      });
    }

    return reports;
  }

  async getEventsPerformanceReport(userRole: UserRole, limit = 20) {
    if (userRole !== UserRole.ADMIN) {
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'Solo administradores pueden ver reportes',
      });
    }

    const events = await this.prisma.event.findMany({
      where: { deletedAt: null },
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: {
        owner: {
          select: {
            name: true,
            email: true,
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
    });

    const eventsWithRevenue = await Promise.all(
      events.map(async (event) => {
        const revenue = await this.prisma.order.aggregate({
          where: {
            eventId: event.id,
            status: 'PAID',
          },
          _sum: { amountCents: true },
        });

        const processedPhotos = await this.prisma.photo.count({
          where: {
            eventId: event.id,
            status: 'PROCESSED',
          },
        });

        return {
          id: event.id,
          name: event.name,
          slug: event.slug,
          date: event.date,
          owner: event.owner,
          stats: {
            totalPhotos: event._count.photos,
            processedPhotos,
            orders: event._count.orders,
            subscriptions: event._count.bibSubscriptions,
            revenueCents: revenue._sum.amountCents || 0,
          },
        };
      })
    );

    return eventsWithRevenue.sort((a, b) => b.stats.revenueCents - a.stats.revenueCents);
  }

  async cleanupOldAuditLogs(userRole: UserRole, daysToKeep = 90) {
    if (userRole !== UserRole.ADMIN) {
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'Solo administradores pueden limpiar logs',
      });
    }

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

    const result = await this.prisma.auditLog.deleteMany({
      where: {
        createdAt: {
          lt: cutoffDate,
        },
      },
    });

    return {
      message: `Logs antiguos eliminados`,
      deletedCount: result.count,
      cutoffDate: cutoffDate.toISOString(),
    };
  }
}
