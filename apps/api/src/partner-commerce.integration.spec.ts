/**
 * Pedidos, liquidaciones y métricas de la Partner API contra PostgreSQL real.
 * Solo corre con E2E_DATABASE_URL (la base debe llamarse *e2e* o *test*): ver enterprise.integration.spec.ts.
 */
import { PrismaClient } from '@prisma/client';
import { NotFoundException } from '@nestjs/common';
import { PartnerCommerceService } from './partner-api/partner-commerce.service';
import { MetricsService } from './metrics/metrics.service';
import { e2eDatabaseUrl } from './test-support/e2e-db';

const url = e2eDatabaseUrl();
const suite = url ? describe : describe.skip;
const stamp = Date.now();

suite('pedidos y métricas de la Partner API contra PostgreSQL real', () => {
  let prisma: any;
  let service: PartnerCommerceService;
  const emitted: any[] = [];
  const A: any = {}; // espacio de la credencial
  const B: any = {}; // otro espacio

  const principal = () => ({ workspaceId: A.ws, actorUserId: A.user, actorRole: 'PHOTOGRAPHER', apiClientId: 'c', keyPrefix: 'k', scopes: ['orders:read'] }) as any;

  async function world(label: string, target: any) {
    const user = await prisma.user.create({ data: { email: `${label}-${stamp}@e2e.test`, role: 'PHOTOGRAPHER' } });
    const ws = await prisma.workspace.create({ data: { name: label, slug: `${label}-${stamp}`, ownerId: user.id } });
    const event = await prisma.event.create({ data: { name: `Evento ${label}`, slug: `ev-${label}-${stamp}`, date: new Date(), ownerId: user.id, workspaceId: ws.id } });
    Object.assign(target, { user: user.id, ws: ws.id, event: event.id });
  }

  async function order(target: any, status: string, amount: number, email: string) {
    const o = await prisma.order.create({ data: { eventId: target.event, amountCents: amount, currency: 'USD', status, guestEmail: email, paymentGateway: 'STRIPE', paidAt: new Date(), items: { create: [{ itemType: 'PHOTO', priceCents: amount }] } } });
    await prisma.ledgerEntry.createMany({ data: [
      { dedupeKey: `${o.id}:g`, orderId: o.id, eventId: target.event, workspaceId: target.ws, type: 'GROSS_SALE', status: 'AVAILABLE', amountCents: amount },
      { dedupeKey: `${o.id}:p`, orderId: o.id, eventId: target.event, type: 'PLATFORM_FEE', status: 'AVAILABLE', amountCents: Math.round(amount * 0.06) },
      { dedupeKey: `${o.id}:e`, orderId: o.id, eventId: target.event, workspaceId: target.ws, type: 'PHOTOGRAPHER_EARNING', status: 'PAID_OUT', amountCents: Math.round(amount * 0.9) },
    ] });
    return o.id as string;
  }

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url } } });
    await world('espacioa', A);
    await world('espaciob', B);
    service = new PartnerCommerceService(prisma, { earnings: jest.fn() } as any, { emit: jest.fn(async (...args: any[]) => { emitted.push(args); }) } as any);
  });

  afterAll(async () => { await prisma?.$disconnect(); });

  it('un espacio solo ve los pedidos de sus eventos, y por defecto solo ventas', async () => {
    const paid = await order(A, 'PAID', 800, 'a1@example.com');
    await order(A, 'REFUNDED', 3000, 'a2@example.com');
    await order(A, 'CREATED', 500, 'abandonado@example.com');
    await order(B, 'PAID', 9999, 'b1@example.com');

    const list = await service.listOrders(principal(), { page: 1, limit: 50 } as any);
    expect(list.items.map(o => o.buyerEmail).sort()).toEqual(['a1@example.com', 'a2@example.com']);
    expect(list.items.every(o => o.eventId === A.event)).toBe(true);
    expect(list.pagination.total).toBe(2);

    const withCreated = await service.listOrders(principal(), { page: 1, limit: 50, status: 'CREATED' } as any);
    expect(withCreated.items.map(o => o.buyerEmail)).toEqual(['abandonado@example.com']);
    expect(paid).toBeTruthy();
  });

  it('el detalle de un pedido ajeno responde 404 y el propio trae su desglose', async () => {
    const mine = await order(A, 'PAID', 1000, 'mio@example.com');
    const theirs = await order(B, 'PAID', 1000, 'ajeno@example.com');
    await expect(service.getOrder(principal(), theirs)).rejects.toBeInstanceOf(NotFoundException);

    const detail: any = await service.getOrder(principal(), mine);
    expect(detail.breakdown).toMatchObject({ grossCents: 1000, platformFeeCents: 60, photographerEarningCents: 900, yourShareCents: 900, yourShareStatus: 'PAID_OUT' });
    expect(detail.items).toHaveLength(1);
    expect(detail).not.toHaveProperty('ledgerEntries');
  });

  it('pagina y filtra por fechas', async () => {
    const page1 = await service.listOrders(principal(), { page: 1, limit: 1 } as any);
    expect(page1.items).toHaveLength(1);
    expect(page1.pagination.pages).toBeGreaterThan(1);
    const none = await service.listOrders(principal(), { page: 1, limit: 50, from: '2000-01-01T00:00:00Z', to: '2000-01-02T00:00:00Z' } as any);
    expect(none.items).toEqual([]);
  });

  it('el aviso de pedido sale al espacio dueño del evento y sin datos de la pasarela', async () => {
    const id = await order(A, 'PAID', 1200, 'aviso@example.com');
    emitted.length = 0;
    await service.emitOrderEvent(id, 'order.paid');
    expect(emitted).toHaveLength(1);
    const [workspaceId, type, payload] = emitted[0];
    expect(workspaceId).toBe(A.ws);
    expect(type).toBe('order.paid');
    expect(payload).toMatchObject({ id, status: 'PAID', amountCents: 1200, buyerEmail: 'aviso@example.com' });
    expect(JSON.stringify(payload)).not.toMatch(/"(stripe\w*|paymentId|accessToken\w*|settlementError)"/);
  });

  it('las métricas de una tienda propia se guardan en un evento sin publicar, con el visitante enviado por el socio', async () => {
    const metrics = new MetricsService(prisma, { get: () => 'secreto-de-prueba' } as any, {} as any, {} as any);
    const req: any = { ip: '203.0.113.9', socket: {}, headers: { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)', referer: 'https://www.instagram.com/', 'x-country-code': 'MX' } };
    await metrics.record({ type: 'EVENT_VIEW', eventId: A.event, sessionId: 's1' } as any, req, undefined, { trustedWorkspaceId: A.ws });
    const row = await prisma.metricEvent.findFirst({ where: { eventId: A.event, type: 'EVENT_VIEW' }, orderBy: { id: 'desc' } });
    expect(row).toMatchObject({ workspaceId: A.ws, device: 'mobile', country: 'MX', channel: 'referral:instagram.com', isBot: false });
    expect(row.visitorHash).toHaveLength(64); // no se guarda la IP, solo su derivado

    await expect(metrics.record({ type: 'EVENT_VIEW', eventId: B.event } as any, req, undefined, { trustedWorkspaceId: A.ws })).rejects.toBeInstanceOf(NotFoundException);
  });
});
