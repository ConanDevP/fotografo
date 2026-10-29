import { NotFoundException } from '@nestjs/common';
import { PartnerCommerceService, summarizeLedger, toPartnerOrder } from './partner-commerce.service';

const principal: any = { workspaceId: 'ws-1', actorUserId: 'u-1', actorRole: 'PHOTOGRAPHER', apiClientId: 'c-1', scopes: ['orders:read'] };

const row = (over: any = {}) => ({
  id: 'o-1', eventId: 'ev-1', status: 'PAID', amountCents: 800, currency: 'USD', paymentGateway: 'STRIPE',
  guestEmail: 'corredor@example.com', paidAt: new Date('2027-03-14T10:00:00Z'), refundedAt: null, disputedAt: null, disputeOutcome: null,
  settlementStatus: 'SETTLED', settledAt: null, createdAt: new Date('2027-03-14T09:59:00Z'),
  event: { name: 'Maratón', workspaceId: 'ws-1' }, user: null, _count: { items: 2 }, ...over,
});

function build(opts: { orders?: any[]; order?: any } = {}) {
  const prisma: any = {
    order: {
      findMany: jest.fn().mockResolvedValue(opts.orders ?? [row()]),
      count: jest.fn().mockResolvedValue((opts.orders ?? [row()]).length),
      findFirst: jest.fn().mockResolvedValue(opts.order ?? null),
      findUnique: jest.fn().mockResolvedValue(row()),
    },
  };
  const billing: any = { earnings: jest.fn().mockResolvedValue({ summary: {}, entries: [] }) };
  const webhooks: any = { emit: jest.fn().mockResolvedValue(undefined) };
  return { prisma, billing, webhooks, service: new PartnerCommerceService(prisma, billing, webhooks) };
}

describe('toPartnerOrder', () => {
  it('muestra solo lo comercial: sin ids de pasarela ni del token de acceso', () => {
    const out: any = toPartnerOrder(row() as any);
    expect(out).toMatchObject({ id: 'o-1', eventName: 'Maratón', status: 'PAID', buyerEmail: 'corredor@example.com', itemCount: 2 });
    for (const forbidden of ['stripeSessionId', 'paymentId', 'accessTokenHash', 'stripeRefundId', 'stripeDisputeId', 'settlementError']) {
      expect(out).not.toHaveProperty(forbidden);
    }
  });

  it('usa el correo de la cuenta cuando no es una compra de invitado', () => {
    expect(toPartnerOrder(row({ guestEmail: null, user: { email: 'cuenta@example.com' } }) as any).buyerEmail).toBe('cuenta@example.com');
    expect(toPartnerOrder(row({ guestEmail: null, user: null }) as any).buyerEmail).toBeNull();
  });
});

describe('summarizeLedger', () => {
  const entries = [
    { type: 'GROSS_SALE', amountCents: 800, workspaceId: 'ws-1', status: 'AVAILABLE' },
    { type: 'PROCESSOR_FEE', amountCents: 54, workspaceId: null, status: 'AVAILABLE' },
    { type: 'PLATFORM_FEE', amountCents: 48, workspaceId: null, status: 'AVAILABLE' },
    { type: 'ORGANIZER_COMMISSION', amountCents: 100, workspaceId: 'ws-1', status: 'PAID_OUT' },
    { type: 'PHOTOGRAPHER_EARNING', amountCents: 598, workspaceId: 'ws-2', status: 'PENDING' },
  ];

  it('separa cada concepto y calcula lo que corresponde al espacio', () => {
    expect(summarizeLedger(entries, 'ws-1')).toMatchObject({
      grossCents: 800, processorFeeCents: 54, platformFeeCents: 48, organizerCommissionCents: 100,
      photographerEarningCents: 598, yourShareCents: 100, yourShareStatus: 'PAID_OUT',
    });
  });

  it('el reembolso llega como importe positivo y un asiento revertido se señala', () => {
    const out = summarizeLedger([
      { type: 'PHOTOGRAPHER_EARNING', amountCents: 500, workspaceId: 'ws-1', status: 'REVERSED' },
      { type: 'REFUND', amountCents: -800, workspaceId: null, status: 'AVAILABLE' },
    ], 'ws-1');
    expect(out.refundedCents).toBe(800);
    expect(out.yourShareStatus).toBe('REVERSED');
  });

  it('sin asientos propios no hay estado de cobro', () => {
    expect(summarizeLedger([{ type: 'GROSS_SALE', amountCents: 800, workspaceId: 'ws-2', status: 'AVAILABLE' }], 'ws-1').yourShareStatus).toBeNull();
  });
});

describe('PartnerCommerceService', () => {
  it('lista solo pedidos de eventos del espacio y, por defecto, solo ventas', async () => {
    const { service, prisma } = build();
    const result = await service.listOrders(principal, { page: 1, limit: 20 } as any);
    const where = prisma.order.findMany.mock.calls[0][0].where;
    expect(where.event).toEqual({ workspaceId: 'ws-1' });
    expect(where.status).toEqual({ in: ['PAID', 'REFUNDED', 'DISPUTED'] });
    expect(result.pagination).toEqual({ page: 1, limit: 20, total: 1, pages: 1 });
  });

  it('aplica los filtros de evento, estado y fechas', async () => {
    const { service, prisma } = build();
    await service.listOrders(principal, { page: 2, limit: 10, eventId: 'ev-9', status: 'REFUNDED', from: '2027-01-01T00:00:00Z', to: '2027-02-01T00:00:00Z' } as any);
    const call = prisma.order.findMany.mock.calls[0][0];
    expect(call.where.status).toBe('REFUNDED');
    expect(call.where.eventId).toBe('ev-9');
    expect(call.where.createdAt).toEqual({ gte: new Date('2027-01-01T00:00:00Z'), lt: new Date('2027-02-01T00:00:00Z') });
    expect(call.skip).toBe(10);
  });

  it('un pedido de otro espacio responde 404', async () => {
    const { service, prisma } = build({ order: null });
    await expect(service.getOrder(principal, 'o-x')).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.order.findFirst.mock.calls[0][0].where).toEqual({ id: 'o-x', event: { workspaceId: 'ws-1' } });
  });

  it('el detalle incluye partidas y desglose', async () => {
    const detail = { ...row(), items: [{ id: 'i1', photoId: 'p1', itemType: 'PHOTO', priceCents: 800 }], ledgerEntries: [{ type: 'GROSS_SALE', amountCents: 800, workspaceId: 'ws-1', status: 'AVAILABLE' }] };
    const { service } = build({ order: detail });
    const out: any = await service.getOrder(principal, 'o-1');
    expect(out.items).toHaveLength(1);
    expect(out.breakdown.grossCents).toBe(800);
    expect(out).not.toHaveProperty('ledgerEntries');
  });

  it('las liquidaciones se piden con el espacio y el actor de la credencial', async () => {
    const { service, billing } = build();
    await service.earnings(principal, { eventId: 'ev-1', limit: 5 } as any);
    expect(billing.earnings).toHaveBeenCalledWith('ws-1', 'u-1', 'PHOTOGRAPHER', { eventId: 'ev-1', limit: 5 });
  });

  it('emite el aviso al espacio dueño del evento con el pedido saneado', async () => {
    const { service, webhooks } = build();
    await service.emitOrderEvent('o-1', 'order.paid');
    expect(webhooks.emit).toHaveBeenCalledWith('ws-1', 'order.paid', expect.objectContaining({ id: 'o-1', status: 'PAID', buyerEmail: 'corredor@example.com' }));
  });

  it('un fallo al avisar no rompe el cobro', async () => {
    const { service, webhooks } = build();
    webhooks.emit.mockRejectedValue(new Error('cola caída'));
    await expect(service.emitOrderEvent('o-1', 'order.refunded')).resolves.toBeUndefined();
  });

  it('un pedido sin espacio (evento borrado) no emite nada', async () => {
    const { service, prisma, webhooks } = build();
    prisma.order.findUnique.mockResolvedValue(row({ event: { name: 'x', workspaceId: null } }));
    await service.emitOrderEvent('o-1', 'order.paid');
    expect(webhooks.emit).not.toHaveBeenCalled();
  });
});
