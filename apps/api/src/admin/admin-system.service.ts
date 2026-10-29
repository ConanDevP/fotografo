import { Injectable, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../common/services/prisma.service';
import { QueueService } from '../common/services/queue.service';
import { UserRole } from '@shared/types';
import { ERROR_CODES } from '@shared/constants';
import { aiCallCostUsd, resolveAiPrices } from './ai-pricing';

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

  /**
   * Coste real de la IA por fotografía y por espacio.
   *
   * Es el número que decide los precios: sale de las llamadas registradas en
   * `ai_usage_logs`, incluidas las que fallan o no encuentran dorsal y suben al
   * modelo mayor. Los precios por modelo se configuran con `AI_PRICING_JSON`.
   */
  async getAiCostReport(userRole: UserRole, days = 30) {
    if (userRole !== UserRole.ADMIN) {
      throw new ForbiddenException({ code: ERROR_CODES.FORBIDDEN, message: 'Solo administradores pueden ver los costes' });
    }
    const since = new Date(Date.now() - Math.min(Math.max(days, 1), 365) * 24 * 60 * 60 * 1000);
    const prices = resolveAiPrices(process.env.AI_PRICING_JSON);

    const byModel = await this.prisma.$queryRaw<Array<{
      model: string; strategy: string; calls: bigint; ok: bigint; with_tokens: bigint; prompt: bigint | null; output: bigint | null;
    }>>`
      SELECT model, strategy, COUNT(*) AS calls,
             COUNT(*) FILTER (WHERE success) AS ok,
             COUNT(*) FILTER (WHERE total_tokens IS NOT NULL) AS with_tokens,
             SUM(prompt_tokens) AS prompt, SUM(output_tokens) AS output
      FROM ai_usage_logs WHERE created_at >= ${since}
      GROUP BY model, strategy ORDER BY model, strategy`;
    const photos = await this.prisma.$queryRaw<Array<{ photos: bigint; escalated: bigint }>>`
      SELECT COUNT(DISTINCT photo_id) AS photos,
             COUNT(DISTINCT photo_id) FILTER (WHERE strategy = 'pro') AS escalated
      FROM ai_usage_logs WHERE created_at >= ${since} AND photo_id IS NOT NULL`;
    const byWorkspace = await this.prisma.$queryRaw<Array<{
      workspace_id: string | null; model: string; photos: bigint; prompt: bigint | null; output: bigint | null;
    }>>`
      SELECT workspace_id, model, COUNT(DISTINCT photo_id) AS photos, SUM(prompt_tokens) AS prompt, SUM(output_tokens) AS output
      FROM ai_usage_logs WHERE created_at >= ${since} GROUP BY workspace_id, model`;

    let totalCost = 0;
    let unpriced = 0;
    const models = byModel.map(row => {
      const cost = aiCallCostUsd(prices, row.model, Number(row.prompt ?? 0), Number(row.output ?? 0));
      if (cost == null) unpriced += Number(row.calls);
      totalCost += cost ?? 0;
      return {
        model: row.model,
        strategy: row.strategy,
        calls: Number(row.calls),
        successfulCalls: Number(row.ok),
        callsWithoutTokenData: Number(row.calls) - Number(row.with_tokens),
        promptTokens: Number(row.prompt ?? 0),
        outputTokens: Number(row.output ?? 0),
        estimatedCostUsd: cost == null ? null : Number(cost.toFixed(4)),
      };
    });
    const distinctPhotos = Number(photos[0]?.photos ?? 0);

    const workspaces = new Map<string, { photos: number; cost: number }>();
    for (const row of byWorkspace) {
      const key = row.workspace_id ?? 'sin-espacio';
      const entry = workspaces.get(key) ?? { photos: 0, cost: 0 };
      entry.photos = Math.max(entry.photos, Number(row.photos));
      entry.cost += aiCallCostUsd(prices, row.model, Number(row.prompt ?? 0), Number(row.output ?? 0)) ?? 0;
      workspaces.set(key, entry);
    }

    return {
      since: since.toISOString(),
      days,
      distinctPhotos,
      escalatedToProPhotos: Number(photos[0]?.escalated ?? 0),
      escalationRate: distinctPhotos ? Number((Number(photos[0]?.escalated ?? 0) / distinctPhotos).toFixed(4)) : null,
      estimatedTotalCostUsd: Number(totalCost.toFixed(4)),
      estimatedCostPerPhotoUsd: distinctPhotos ? Number((totalCost / distinctPhotos).toFixed(6)) : null,
      estimatedCostPer1000PhotosUsd: distinctPhotos ? Number(((totalCost / distinctPhotos) * 1000).toFixed(2)) : null,
      unpricedCalls: unpriced,
      models,
      topWorkspaces: [...workspaces.entries()]
        .map(([workspaceId, v]) => ({ workspaceId, photos: v.photos, estimatedCostUsd: Number(v.cost.toFixed(4)) }))
        .sort((a, b) => b.estimatedCostUsd - a.estimatedCostUsd)
        .slice(0, 20),
      notes: [
        'Solo cubre el OCR de dorsales. No incluye almacenamiento, cómputo del servicio de rostros ni el procesamiento de miniaturas.',
        'Los precios por modelo son configurables con AI_PRICING_JSON y deben contrastarse con la tarifa vigente del proveedor.',
      ],
    };
  }
}
