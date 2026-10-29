import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { UserRole } from '@shared/types';
import { PrismaService } from '../common/services/prisma.service';
import { BillingService } from '../billing/billing.service';
import { PartnerPrincipal } from './partner-api.types';
import { PartnerWebhooksService } from './partner-webhooks.service';
import { PartnerOrderListQueryDto, PartnerEarningsQueryDto } from './dto/partner-commerce.dto';

/** Estados que se listan por defecto: los pedidos abandonados (CREATED, CANCELLED) no son ventas. */
const SALE_STATUSES = ['PAID', 'REFUNDED', 'DISPUTED'] as const;

const ORDER_SELECT = {
  id: true,
  eventId: true,
  status: true,
  amountCents: true,
  currency: true,
  paymentGateway: true,
  guestEmail: true,
  paidAt: true,
  refundedAt: true,
  disputedAt: true,
  disputeOutcome: true,
  settlementStatus: true,
  settledAt: true,
  createdAt: true,
  event: { select: { name: true, workspaceId: true } },
  user: { select: { email: true } },
  _count: { select: { items: true } },
} satisfies Prisma.OrderSelect;

type OrderRow = Prisma.OrderGetPayload<{ select: typeof ORDER_SELECT }>;

/** Pedido tal y como lo ve un socio: solo lo comercial, sin identificadores de la pasarela. */
export function toPartnerOrder(order: OrderRow) {
  return {
    id: order.id,
    eventId: order.eventId,
    eventName: order.event?.name ?? null,
    status: order.status,
    amountCents: order.amountCents,
    currency: order.currency,
    paymentGateway: order.paymentGateway,
    buyerEmail: order.guestEmail ?? order.user?.email ?? null,
    itemCount: order._count.items,
    paidAt: order.paidAt,
    refundedAt: order.refundedAt,
    disputedAt: order.disputedAt,
    disputeOutcome: order.disputeOutcome,
    settlementStatus: order.settlementStatus,
    settledAt: order.settledAt,
    createdAt: order.createdAt,
  };
}

/** Suma por tipo de asiento del libro contable de un pedido. */
export function summarizeLedger(
  entries: Array<{ type: string; amountCents: number; workspaceId: string | null; status: string }>,
  workspaceId: string,
) {
  const total = (...types: string[]) => entries.filter(e => types.includes(e.type)).reduce((sum, e) => sum + e.amountCents, 0);
  const own = entries.filter(e => e.workspaceId === workspaceId && ['ORGANIZER_COMMISSION', 'PHOTOGRAPHER_EARNING'].includes(e.type));
  return {
    grossCents: total('GROSS_SALE'),
    processorFeeCents: total('PROCESSOR_FEE'),
    platformFeeCents: total('PLATFORM_FEE'),
    organizerCommissionCents: total('ORGANIZER_COMMISSION'),
    photographerEarningCents: total('PHOTOGRAPHER_EARNING'),
    refundedCents: Math.abs(total('REFUND')),
    disputedCents: total('DISPUTE'),
    disputeFeeCents: total('DISPUTE_FEE'),
    // Lo que de esta venta le corresponde a tu espacio y cómo va su cobro.
    yourShareCents: own.reduce((sum, e) => sum + e.amountCents, 0),
    yourShareStatus: own.length === 0 ? null : own.every(e => e.status === 'PAID_OUT') ? 'PAID_OUT' : own.some(e => e.status === 'REVERSED') ? 'REVERSED' : 'PENDING',
  };
}

@Injectable()
export class PartnerCommerceService {
  private readonly logger = new Logger(PartnerCommerceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly billing: BillingService,
    private readonly webhooks: PartnerWebhooksService,
  ) {}

  async listOrders(principal: PartnerPrincipal, query: PartnerOrderListQueryDto) {
    const range: Prisma.DateTimeFilter = {};
    if (query.from) range.gte = new Date(query.from);
    if (query.to) range.lt = new Date(query.to);
    const where: Prisma.OrderWhereInput = {
      event: { workspaceId: principal.workspaceId },
      status: query.status ? query.status : { in: [...SALE_STATUSES] },
      ...(query.eventId ? { eventId: query.eventId } : {}),
      ...(query.from || query.to ? { createdAt: range } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        select: ORDER_SELECT,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.order.count({ where }),
    ]);
    return {
      items: rows.map(toPartnerOrder),
      pagination: { page: query.page, limit: query.limit, total, pages: Math.ceil(total / query.limit) },
    };
  }

  async getOrder(principal: PartnerPrincipal, orderId: string) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, event: { workspaceId: principal.workspaceId } },
      select: {
        ...ORDER_SELECT,
        items: { select: { id: true, photoId: true, itemType: true, priceCents: true }, orderBy: { id: 'asc' } },
        ledgerEntries: { select: { type: true, status: true, amountCents: true, workspaceId: true } },
      },
    });
    if (!order) throw new NotFoundException('Pedido no encontrado');
    const { items, ledgerEntries, ...rest } = order;
    return { ...toPartnerOrder(rest), items, breakdown: summarizeLedger(ledgerEntries, principal.workspaceId) };
  }

  async earnings(principal: PartnerPrincipal, query: PartnerEarningsQueryDto) {
    return this.billing.earnings(principal.workspaceId, principal.actorUserId, principal.actorRole as UserRole, {
      eventId: query.eventId,
      limit: query.limit,
    });
  }

  /**
   * Avisa a los webhooks del espacio dueño del evento. Nunca debe romper el flujo de pago: el cobro ya
   * ocurrió y un fallo aquí solo significa que el aviso no sale.
   */
  async emitOrderEvent(orderId: string, type: 'order.paid' | 'order.refunded' | 'order.disputed' | 'order.dispute.closed'): Promise<void> {
    try {
      const order = await this.prisma.order.findUnique({ where: { id: orderId }, select: ORDER_SELECT });
      const workspaceId = order?.event?.workspaceId;
      if (!order || !workspaceId) return;
      await this.webhooks.emit(workspaceId, type, toPartnerOrder(order));
    } catch (error) {
      this.logger.warn(`No se pudo emitir ${type} del pedido ${orderId}: ${error instanceof Error ? error.message : 'error'}`);
    }
  }
}
