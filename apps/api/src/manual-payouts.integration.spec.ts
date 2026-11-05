/**
 * Saldos por pagar a mano, contra PostgreSQL real: qué se debe, que un importe
 * no se pague dos veces ni a medias, y qué pasa si el pedido se reembolsa
 * después de haberse pagado. Solo corre con E2E_DATABASE_URL.
 */
import { PrismaClient } from '@prisma/client';
import { ConflictException, BadRequestException } from '@nestjs/common';
import { ManualPayoutsService } from './payments/manual-payouts.service';
import { PaymentsService } from './payments/payments.service';
import { e2eDatabaseUrl } from './test-support/e2e-db';

const url = e2eDatabaseUrl();
const suite = url ? describe : describe.skip;
const stamp = Date.now();

suite('pagos manuales contra PostgreSQL real', () => {
  let prisma: any;
  let service: ManualPayoutsService;
  let sent: Array<{ to: string; subject: string; html: string }>;
  let mailerOk = true;
  let admin: { id: string };
  let foto: { id: string; email: string };
  let connected: { id: string };
  let wsFoto: string;
  let wsConnected: string;
  let eventId: string;

  async function sale(opts: { beneficiary: { id: string }; workspaceId: string; currency?: string; amount?: number; status?: string; settlementStatus?: string; refundRequestedAt?: Date | null }) {
    const order = await prisma.order.create({
      data: {
        eventId,
        amountCents: 1000,
        currency: opts.currency ?? 'USD',
        status: opts.status ?? 'PAID',
        paidAt: new Date(),
        paymentGateway: 'stripe',
        stripeSessionId: `cs_${stamp}_${Math.random()}`,
        settlementStatus: opts.settlementStatus ?? 'PARTIAL',
        refundRequestedAt: opts.refundRequestedAt ?? null,
      },
    });
    const entry = await prisma.ledgerEntry.create({
      data: {
        dedupeKey: `${order.id}:earn`,
        orderId: order.id,
        eventId,
        workspaceId: opts.workspaceId,
        beneficiaryUserId: opts.beneficiary.id,
        type: 'PHOTOGRAPHER_EARNING',
        status: 'AVAILABLE',
        amountCents: opts.amount ?? 800,
        currency: opts.currency ?? 'USD',
      },
    });
    return { order, entry };
  }

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url } } });
    sent = [];
    const mailer: any = {
      isConfigured: true,
      send: async (mail: { to: string; subject: string; html: string }) => {
        sent.push(mail);
        return mailerOk;
      },
    };
    const config: any = { get: (key: string) => (key === 'APP_URL' ? 'https://lucilamon.test/' : undefined) };
    service = new ManualPayoutsService(prisma, mailer, config);
    admin = await prisma.user.create({ data: { email: `adm-${stamp}@e2e.test`, role: 'ADMIN' } });
    foto = await prisma.user.create({ data: { email: `foto-${stamp}@e2e.test`, name: 'Foto', role: 'PHOTOGRAPHER' } });
    connected = await prisma.user.create({
      data: {
        email: `conn-${stamp}@e2e.test`, role: 'PHOTOGRAPHER',
        stripeAccountId: `acct_${stamp}`, stripeOnboardingCompleted: true, stripeChargesEnabled: true, stripePayoutsEnabled: true,
      },
    });
    wsFoto = (await prisma.workspace.create({ data: { name: 'Foto', slug: `mp-foto-${stamp}`, ownerId: foto.id } })).id;
    wsConnected = (await prisma.workspace.create({ data: { name: 'Conectado', slug: `mp-conn-${stamp}`, ownerId: connected.id } })).id;
    eventId = (await prisma.event.create({
      data: { name: 'Carrera pagos', slug: `mp-${stamp}`, date: new Date(), ownerId: foto.id, workspaceId: wsFoto, isPublished: true },
    })).id;
  });

  afterAll(async () => { await prisma?.$disconnect(); });

  it('lista lo que se debe por persona y moneda, y marca a quien Stripe pagará solo', async () => {
    await sale({ beneficiary: foto, workspaceId: wsFoto, amount: 800 });
    await sale({ beneficiary: foto, workspaceId: wsFoto, amount: 700 });
    await sale({ beneficiary: foto, workspaceId: wsFoto, amount: 90000, currency: 'HNL' });
    await sale({ beneficiary: connected, workspaceId: wsConnected, amount: 500 });
    // No se debe nada de un pedido ya reembolsado.
    await sale({ beneficiary: foto, workspaceId: wsFoto, amount: 999, status: 'REFUNDED' });

    const { pending } = await service.overview();
    const mine = pending.filter(group => group.beneficiary?.id === foto.id);

    expect(mine.map(group => [group.currency, group.totalCents, group.entryCount]).sort()).toEqual([
      ['HNL', 90000, 1],
      ['USD', 1500, 2],
    ]);
    expect(mine.every(group => group.stripeReady === false)).toBe(true);
    expect(pending.find(group => group.beneficiary?.id === connected.id)?.stripeReady).toBe(true);
  });

  it('marca como pagados todos los importes elegidos, deja constancia y liquida los pedidos', async () => {
    const a = await sale({ beneficiary: foto, workspaceId: wsFoto, amount: 300 });
    const b = await sale({ beneficiary: foto, workspaceId: wsFoto, amount: 200 });

    const result = await service.markPaid(admin.id, {
      entryIds: [a.entry.id, b.entry.id], method: 'BANK_TRANSFER', reference: 'TRF-123', note: 'Banco Atlántida',
    });

    expect(result).toMatchObject({ totalCents: 500, currency: 'USD', entryCount: 2 });
    const entries = await prisma.ledgerEntry.findMany({ where: { id: { in: [a.entry.id, b.entry.id] } } });
    for (const entry of entries) {
      expect(entry.status).toBe('PAID_OUT');
      expect(entry.paidOutAt).not.toBeNull();
      expect(entry.externalTransferId).toBeNull();
      expect(entry.metadata.manualPayout).toMatchObject({ method: 'BANK_TRANSFER', reference: 'TRF-123', paidBy: admin.id });
    }
    const orders = await prisma.order.findMany({ where: { id: { in: [a.order.id, b.order.id] } } });
    expect(orders.every((order: any) => order.settlementStatus === 'SETTLED')).toBe(true);

    const log = await prisma.auditLog.findFirst({ where: { action: 'MANUAL_PAYOUT', userId: admin.id }, orderBy: { createdAt: 'desc' } });
    expect(log.data).toMatchObject({ reference: 'TRF-123', totalCents: 500, beneficiaryEmail: foto.email });
  });

  it('no paga dos veces: si dos administradores marcan lo mismo a la vez, solo uno lo consigue', async () => {
    const { entry } = await sale({ beneficiary: foto, workspaceId: wsFoto, amount: 400 });
    const pay = (reference: string) => service.markPaid(admin.id, { entryIds: [entry.id], method: 'PAYONEER', reference });

    const results = await Promise.allSettled([pay('A'), pay('B')]);

    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
    const stored = await prisma.ledgerEntry.findUnique({ where: { id: entry.id } });
    expect(['A', 'B']).toContain(stored.metadata.manualPayout.reference);
  });

  it('es todo o nada: si un importe ya se pagó, no se marca ninguno de los demás', async () => {
    const paid = await sale({ beneficiary: foto, workspaceId: wsFoto, amount: 100 });
    const open = await sale({ beneficiary: foto, workspaceId: wsFoto, amount: 100 });
    await service.markPaid(admin.id, { entryIds: [paid.entry.id], method: 'CASH', reference: 'R-1' });

    await expect(
      service.markPaid(admin.id, { entryIds: [open.entry.id, paid.entry.id], method: 'CASH', reference: 'R-2' }),
    ).rejects.toThrow(ConflictException);

    expect((await prisma.ledgerEntry.findUnique({ where: { id: open.entry.id } })).status).toBe('AVAILABLE');
  });

  it('no mezcla personas ni monedas en un mismo pago', async () => {
    const usd = await sale({ beneficiary: foto, workspaceId: wsFoto, amount: 100 });
    const hnl = await sale({ beneficiary: foto, workspaceId: wsFoto, amount: 100, currency: 'HNL' });
    const otro = await sale({ beneficiary: connected, workspaceId: wsConnected, amount: 100 });

    await expect(service.markPaid(admin.id, { entryIds: [usd.entry.id, hnl.entry.id], method: 'CASH', reference: 'x' })).rejects.toThrow(BadRequestException);
    await expect(service.markPaid(admin.id, { entryIds: [usd.entry.id, otro.entry.id], method: 'CASH', reference: 'x' })).rejects.toThrow(BadRequestException);
  });

  it('no paga a mano a quien Stripe ya puede pagar, ni pedidos reembolsados o con reembolso en curso', async () => {
    const stripeReady = await sale({ beneficiary: connected, workspaceId: wsConnected, amount: 100 });
    const reembolsado = await sale({ beneficiary: foto, workspaceId: wsFoto, amount: 100, status: 'REFUNDED' });
    const enCurso = await sale({ beneficiary: foto, workspaceId: wsFoto, amount: 100, refundRequestedAt: new Date() });
    const procesando = await sale({ beneficiary: foto, workspaceId: wsFoto, amount: 100, settlementStatus: 'PROCESSING' });

    for (const { entry } of [stripeReady, reembolsado, enCurso, procesando]) {
      await expect(service.markPaid(admin.id, { entryIds: [entry.id], method: 'CASH', reference: 'x' })).rejects.toThrow();
      expect((await prisma.ledgerEntry.findUnique({ where: { id: entry.id } })).status).toBe('AVAILABLE');
    }
  });

  it('exige referencia del pago', async () => {
    const { entry } = await sale({ beneficiary: foto, workspaceId: wsFoto, amount: 100 });
    await expect(service.markPaid(admin.id, { entryIds: [entry.id], method: 'CASH', reference: '   ' })).rejects.toThrow(BadRequestException);
  });

  it('si el pedido se reembolsa después de pagarse a mano, el reembolso sigue y el importe queda marcado para recuperar', async () => {
    const { order, entry } = await sale({ beneficiary: foto, workspaceId: wsFoto, amount: 600, settlementStatus: 'PARTIAL' });
    await service.markPaid(admin.id, { entryIds: [entry.id], method: 'BANK_TRANSFER', reference: 'TRF-9' });

    // El resto del flujo de reembolso (Stripe) se sustituye por un doble; lo que se prueba es el libro.
    const stripe = {
      checkout: { sessions: { retrieve: async () => ({ payment_intent: 'pi_1' }) } },
      refunds: { create: async () => ({ id: `re_${stamp}` }) },
      transfers: { createReversal: async () => { throw new Error('no debería revertirse nada en Stripe'); } },
    };
    const payments: any = Object.create(PaymentsService.prototype);
    payments.logger = { log: () => undefined, warn: () => undefined, error: () => undefined };
    payments.prisma = prisma;
    payments.paymentGatewayFactory = { createGateway: () => ({ getStripeInstance: () => stripe }) };
    payments.partnerCommerce = undefined;

    const refunded = await payments.refundOrder(order.id, 'prueba', admin.id, 'ADMIN');

    expect(refunded.status).toBe('REFUNDED');
    const stored = await prisma.ledgerEntry.findUnique({ where: { id: entry.id } });
    expect(stored.status).toBe('PAID_OUT');
    expect(stored.failureReason).toContain('pendiente de ajuste');

    const { toRecover } = await service.overview();
    expect(toRecover.some(item => item.id === entry.id)).toBe(true);
  });

  it('avisa por correo a quien cobra, sin la nota interna, y un fallo del correo no deshace el pago', async () => {
    const a = await sale({ beneficiary: foto, workspaceId: wsFoto, amount: 1250 });
    sent.length = 0;
    const result = await service.markPaid(admin.id, { entryIds: [a.entry.id], method: 'PAYONEER', reference: 'PY-77', note: 'secreto interno' });

    expect(result.notified).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(foto.email);
    expect(sent[0].html).toContain('PY-77');
    expect(sent[0].html).toContain('Payoneer');
    expect(sent[0].html).toContain('https://lucilamon.test/dashboard/billing');
    expect(sent[0].html).not.toContain('secreto interno');

    const b = await sale({ beneficiary: foto, workspaceId: wsFoto, amount: 300 });
    mailerOk = false;
    const failed = await service.markPaid(admin.id, { entryIds: [b.entry.id], method: 'CASH', reference: 'R-5' });
    mailerOk = true;
    expect(failed.notified).toBe(false);
    expect((await prisma.ledgerEntry.findUnique({ where: { id: b.entry.id } })).status).toBe('PAID_OUT');
  });

  describe('recuperar lo pagado a mano y luego reembolsado', () => {
    async function paidThenRefunded(amount: number) {
      const { order, entry } = await sale({ beneficiary: foto, workspaceId: wsFoto, amount });
      await service.markPaid(admin.id, { entryIds: [entry.id], method: 'BANK_TRANSFER', reference: `T-${amount}` });
      await prisma.order.update({ where: { id: order.id }, data: { status: 'REFUNDED' } });
      return entry;
    }

    it('lo deja constancia, conserva el pago original y lo saca de la lista por recuperar', async () => {
      const entry = await paidThenRefunded(710);
      expect((await service.overview()).toRecover.some(item => item.id === entry.id)).toBe(true);

      const result = await service.markRecovered(admin.id, { entryIds: [entry.id], method: 'BANK_TRANSFER', reference: 'DEV-1', note: 'devolvió' });

      expect(result).toMatchObject({ totalCents: 710, entryCount: 1 });
      const stored = await prisma.ledgerEntry.findUnique({ where: { id: entry.id } });
      expect(stored.status).toBe('PAID_OUT');
      expect(stored.metadata.manualPayout.reference).toBe('T-710');
      expect(stored.metadata.recovery).toMatchObject({ method: 'BANK_TRANSFER', reference: 'DEV-1', recoveredBy: admin.id });
      expect((await service.overview()).toRecover.some(item => item.id === entry.id)).toBe(false);
      const log = await prisma.auditLog.findFirst({ where: { action: 'MANUAL_PAYOUT_RECOVERED', userId: admin.id }, orderBy: { createdAt: 'desc' } });
      expect(log.data).toMatchObject({ totalCents: 710 });
    });

    it('no se puede recuperar dos veces, ni a la vez', async () => {
      const entry = await paidThenRefunded(720);
      const attempt = (reference: string) => service.markRecovered(admin.id, { entryIds: [entry.id], method: 'CASH', reference });

      const results = await Promise.allSettled([attempt('A'), attempt('B')]);
      expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
      await expect(attempt('C')).rejects.toThrow(ConflictException);
    });

    it('descontar o asumir no pide referencia; recuperar dinero sí', async () => {
      const offset = await paidThenRefunded(730);
      const money = await paidThenRefunded(740);

      await expect(service.markRecovered(admin.id, { entryIds: [money.id], method: 'BANK_TRANSFER' })).rejects.toThrow(BadRequestException);
      await expect(service.markRecovered(admin.id, { entryIds: [offset.id], method: 'OFFSET' })).resolves.toMatchObject({ totalCents: 730 });
    });

    it('rechaza importes que no están pendientes de recuperar', async () => {
      const aunPagado = await sale({ beneficiary: foto, workspaceId: wsFoto, amount: 100 });
      await service.markPaid(admin.id, { entryIds: [aunPagado.entry.id], method: 'CASH', reference: 'ok' });
      const abierto = await sale({ beneficiary: foto, workspaceId: wsFoto, amount: 100 });

      // Pagado pero el pedido sigue cobrado: no hay nada que recuperar.
      await expect(service.markRecovered(admin.id, { entryIds: [aunPagado.entry.id], method: 'OFFSET' })).rejects.toThrow(BadRequestException);
      // Aún por pagar.
      await expect(service.markRecovered(admin.id, { entryIds: [abierto.entry.id], method: 'OFFSET' })).rejects.toThrow(BadRequestException);
    });
  });
});
