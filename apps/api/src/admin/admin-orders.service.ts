import { Injectable, ForbiddenException, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../common/services/prisma.service';
import { UserRole } from '@shared/types';
import { ERROR_CODES } from '@shared/constants';

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
      totalRevenue,
      recentOrders,
      avgOrderValue,
    ] = await Promise.all([
      this.prisma.order.count(),
      this.prisma.order.groupBy({
        by: ['status'],
        _count: { status: true },
        _sum: { amountCents: true },
      }),
      this.prisma.order.aggregate({
        where: { status: 'PAID' },
        _sum: { amountCents: true },
      }),
      this.prisma.order.count({
        where: {
          createdAt: {
            gte: new Date(Date.now() - 24 * 60 * 60 * 1000), // Last 24 hours
          },
        },
      }),
      this.prisma.order.aggregate({
        where: { status: 'PAID' },
        _avg: { amountCents: true },
      }),
    ]);

    const statusStats = ordersByStatus.reduce((acc, stat) => {
      acc[stat.status] = {
        count: stat._count.status,
        revenue: stat._sum.amountCents || 0,
      };
      return acc;
    }, {} as Record<string, { count: number; revenue: number }>);

    return {
      total: totalOrders,
      byStatus: statusStats,
      totalRevenue: totalRevenue._sum.amountCents || 0,
      avgOrderValue: avgOrderValue._avg.amountCents || 0,
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

    const where: any = {
      status: 'PAID',
    };

    if (dateFrom || dateTo) {
      where.createdAt = {};
      if (dateFrom) where.createdAt.gte = new Date(dateFrom);
      if (dateTo) where.createdAt.lte = new Date(dateTo);
    }

    const orders = await this.prisma.order.findMany({
      where,
      select: {
        amountCents: true,
        createdAt: true,
        eventId: true,
      },
      orderBy: { createdAt: 'asc' },
    });

    // Group by period
    const grouped: Record<string, { revenue: number; count: number }> = {};

    orders.forEach((order) => {
      let key: string;
      const date = new Date(order.createdAt);

      switch (period) {
        case 'daily':
          key = date.toISOString().split('T')[0];
          break;
        case 'monthly':
          key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
          break;
        case 'yearly':
          key = String(date.getFullYear());
          break;
      }

      if (!grouped[key]) {
        grouped[key] = { revenue: 0, count: 0 };
      }

      grouped[key].revenue += order.amountCents;
      grouped[key].count += 1;
    });

    return Object.entries(grouped).map(([period, data]) => ({
      period,
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
