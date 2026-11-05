import { Injectable, ForbiddenException, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../common/services/prisma.service';
import { UserRole } from '@shared/types';
import { ERROR_CODES } from '@shared/constants';
import { addMoney, MoneyByCurrency, paidInRange, primaryMoney, sumRowsByCurrency } from '../common/utils/revenue';

@Injectable()
export class AdminOrdersService {
  constructor(private prisma: PrismaService) {}

  async getAllOrders(
    userRole: UserRole,
    page = 1,
    limit = 20,
    filters?: {
      status?: string;
      userId?: string;
      eventId?: string;
      dateFrom?: string;
      dateTo?: string;
    }
  ) {
    if (userRole !== UserRole.ADMIN) {
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'Solo administradores pueden listar todas las órdenes',
      });
    }

    const skip = (page - 1) * limit;
    const where: any = {};

    if (filters?.status) {
      where.status = filters.status;
    }

    if (filters?.userId) {
      where.userId = filters.userId;
    }

    if (filters?.eventId) {
      where.eventId = filters.eventId;
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

    const [orders, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          user: {
            select: {
              id: true,
              email: true,
              name: true,
            },
          },
          event: {
            select: {
              id: true,
              name: true,
              slug: true,
            },
          },
          items: {
            include: {
              photo: {
                select: {
                  id: true,
                  thumbUrl: true,
                  watermarkUrl: true,
                },
              },
            },
          },
        },
      }),
      this.prisma.order.count({ where }),
    ]);

    return {
      items: orders,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }

  async getOrderById(orderId: string, userRole: UserRole) {
    if (userRole !== UserRole.ADMIN) {
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'Solo administradores pueden ver detalles de órdenes',
      });
    }

    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            name: true,
            phone: true,
          },
        },
        event: {
          select: {
            id: true,
            name: true,
            slug: true,
            date: true,
            location: true,
          },
        },
        items: {
          include: {
            photo: {
              select: {
                id: true,
                thumbUrl: true,
                watermarkUrl: true,
                originalUrl: true,
                cloudinaryId: true,
              },
            },
          },
        },
      },
    });

    if (!order) {
      throw new NotFoundException({
        code: ERROR_CODES.ORDER_NOT_FOUND,
        message: 'Orden no encontrada',
      });
    }

    return order;
  }

  async updateOrderStatus(orderId: string, status: string, userRole: UserRole) {
    if (userRole !== UserRole.ADMIN) {
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'Solo administradores pueden actualizar órdenes',
      });
    }

    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
    });

    if (!order) {
      throw new NotFoundException({
        code: ERROR_CODES.ORDER_NOT_FOUND,
        message: 'Orden no encontrada',
      });
    }

    if (status !== 'CANCELLED' || order.status !== 'CREATED') {
      throw new BadRequestException({
        code: ERROR_CODES.VALIDATION_ERROR,
        message: 'El estado de pago no se modifica manualmente. Solo puedes cancelar pedidos todavía no pagados.',
      });
    }

    const updatedOrder = await this.prisma.order.update({
      where: { id: orderId },
      data: { status: status as any },
      include: {
        user: {
          select: {
            email: true,
            name: true,
          },
        },
      },
    });

    // Log the action
    await this.prisma.auditLog.create({
      data: {
        action: 'ORDER_STATUS_UPDATED',
        data: {
          orderId,
          oldStatus: order.status,
          newStatus: status,
        },
      },
    });

    return updatedOrder;
  }

  async getOrdersStats(userRole: UserRole) {
    if (userRole !== UserRole.ADMIN) {
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'Solo administradores pueden ver estadísticas de órdenes',
      });
    }

    const [
      totalOrders,
      ordersByStatus,
      paidRows,
      recentOrders,
    ] = await Promise.all([
      this.prisma.order.count(),
      // Por moneda: los importes de monedas distintas no se suman.
      this.prisma.order.groupBy({
        by: ['status', 'currency'],
        _count: { _all: true },
        _sum: { amountCents: true },
      }),
      this.prisma.order.groupBy({
        by: ['currency'],
        where: { status: 'PAID' },
        _count: { _all: true },
        _sum: { amountCents: true },
      }),
      this.prisma.order.count({
        where: {
          createdAt: {
            gte: new Date(Date.now() - 24 * 60 * 60 * 1000), // Last 24 hours
          },
        },
      }),
    ]);

    const perStatus = new Map<string, { count: number; money: MoneyByCurrency }>();
    for (const stat of ordersByStatus) {
      const bucket = perStatus.get(stat.status) ?? { count: 0, money: {} };
      bucket.count += stat._count._all;
      addMoney(bucket.money, stat.currency, stat._sum.amountCents);
      perStatus.set(stat.status, bucket);
    }
    const statusStats: Record<string, { count: number; revenue: number; revenueByCurrency: MoneyByCurrency }> = {};
    for (const [status, bucket] of perStatus) {
      const money = primaryMoney(bucket.money);
      statusStats[status] = { count: bucket.count, revenue: money.cents, revenueByCurrency: money.byCurrency };
    }

    const paid = primaryMoney(sumRowsByCurrency(paidRows, row => row._sum.amountCents));
    const paidInPrimary = paidRows.find(row => row.currency.toUpperCase() === paid.currency)?._count._all ?? 0;

    return {
      total: totalOrders,
      byStatus: statusStats,
      totalRevenue: paid.cents,
      currency: paid.currency,
      revenueByCurrency: paid.byCurrency,
      mixedCurrencies: paid.mixedCurrencies,
      avgOrderValue: paidInPrimary > 0 ? paid.cents / paidInPrimary : 0,
      recentOrders,
    };
  }

  async getRevenueReport(
    userRole: UserRole,
    period: 'daily' | 'monthly' | 'yearly',
    dateFrom?: string,
    dateTo?: string
  ) {
    if (userRole !== UserRole.ADMIN) {
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'Solo administradores pueden ver reportes de ingresos',
      });
    }

    // Por fecha de cobro, y una fila por periodo y moneda.
    const orders = await this.prisma.order.findMany({
      where: paidInRange(dateFrom ? new Date(dateFrom) : undefined, dateTo ? new Date(dateTo) : undefined),
      select: {
        amountCents: true,
        currency: true,
        paidAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });

    const grouped: Record<string, { period: string; currency: string; revenue: number; count: number }> = {};

    orders.forEach((order) => {
      const date = new Date(order.paidAt ?? order.createdAt);
      const iso = date.toISOString();
      const periodKey = period === 'daily' ? iso.slice(0, 10) : period === 'monthly' ? iso.slice(0, 7) : iso.slice(0, 4);
      const currency = (order.currency || 'USD').toUpperCase();
      const key = `${periodKey}|${currency}`;

      if (!grouped[key]) {
        grouped[key] = { period: periodKey, currency, revenue: 0, count: 0 };
      }

      grouped[key].revenue += order.amountCents;
      grouped[key].count += 1;
    });

    return Object.values(grouped)
      .sort((a, b) => a.period.localeCompare(b.period) || a.currency.localeCompare(b.currency))
      .map(data => ({
        period: data.period,
        currency: data.currency,
        revenue: data.revenue,
        orders: data.count,
        avgOrderValue: data.count > 0 ? data.revenue / data.count : 0,
      }));
  }

  async deleteOrder(orderId: string, userRole: UserRole) {
    if (userRole !== UserRole.ADMIN) {
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'Solo administradores pueden eliminar órdenes',
      });
    }

    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
    });

    if (!order) {
      throw new NotFoundException({
        code: ERROR_CODES.ORDER_NOT_FOUND,
        message: 'Orden no encontrada',
      });
    }

    // Only allow deletion of CREATED or CANCELLED orders
    if (order.status === 'PAID' || order.status === 'REFUNDED') {
      throw new BadRequestException({
        code: ERROR_CODES.CANNOT_DELETE_ORDER,
        message: 'No se puede eliminar una orden pagada o reembolsada',
      });
    }

    await this.prisma.order.delete({
      where: { id: orderId },
    });

    return { message: 'Orden eliminada correctamente' };
  }
}
