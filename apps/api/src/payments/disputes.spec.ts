import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';

import { PaymentsService } from './payments.service';
import { PrismaService } from '../common/services/prisma.service';
import { StorageService } from '../common/services/storage.service';
import { QueueService } from '../common/services/queue.service';
import { PaymentGatewayFactory } from './factories/payment-gateway.factory';
import { BillingService } from '../billing/billing.service';

describe('Contracargos', () => {
  let service: PaymentsService;
  let prisma: any;
  let stripe: any;

  const ORDER = { id: 'ord-1', eventId: 'ev-1', currency: 'USD', stripeDisputeId: null };

  beforeEach(async () => {
    prisma = {
      order: {
        findFirst: jest.fn().mockResolvedValue(ORDER),
        findUnique: jest.fn().mockResolvedValue({
          createdAt: new Date('2026-08-01T10:00:00Z'),
          guestEmail: 'atleta@test.com',
          refundPolicyAcceptedAt: new Date('2026-08-01T09:59:00Z'),
          user: null,
          event: { name: 'Maratón' },
          _count: { items: 3 },
        }),
        update: jest.fn().mockResolvedValue({}),
      },
      ledgerEntry: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'le-1', externalTransferId: 'tr_foto' },
          { id: 'le-2', externalTransferId: 'tr_org' },
        ]),
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
        update: jest.fn().mockResolvedValue({}),
      },
      metricEvent: {
        findMany: jest.fn().mockResolvedValue([
          { createdAt: new Date('2026-08-01T10:05:00Z'), source: 'zip' },
        ]),
      },
    };

    stripe = {
      transfers: { createReversal: jest.fn().mockResolvedValue({ id: 'trr_1' }) },
      disputes: { update: jest.fn().mockResolvedValue({}) },
      charges: { retrieve: jest.fn() },
      checkout: { sessions: { list: jest.fn() } },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentsService,
        { provide: PrismaService, useValue: prisma },
        { provide: StorageService, useValue: {} },
        { provide: QueueService, useValue: {} },
        { provide: ConfigService, useValue: { get: (_: string, d?: any) => d } },
        { provide: PaymentGatewayFactory, useValue: { createGateway: () => ({ getStripeInstance: () => stripe }) } },
        { provide: BillingService, useValue: {} },
      ],
    }).compile();

    service = module.get<PaymentsService>(PaymentsService);
  });

  const abrir = (over: any = {}) =>
    service.handleDisputeOpened({
      disputeId: 'dp_1', chargeId: 'ch_1', amountCents: 1000, feeCents: 1500, ...over,
    });

  it('recupera del fotógrafo lo ya transferido', async () => {
    await abrir();

    expect(stripe.transfers.createReversal).toHaveBeenCalledTimes(2);
    expect(stripe.transfers.createReversal).toHaveBeenCalledWith(
      'tr_foto', expect.anything(), expect.objectContaining({ idempotencyKey: expect.any(String) }),
    );
  });

  it('corta el acceso a la descarga y marca el pedido en disputa', async () => {
    await abrir();

    expect(prisma.order.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'DISPUTED',
          accessTokenHash: null,
          accessTokenExpiresAt: null,
        }),
      }),
    );
  });

  it('anota importe y comisión como movimientos separados', async () => {
    await abrir();

    const tipos = prisma.ledgerEntry.createMany.mock.calls[0][0].data.map((e: any) => e.type);
    // La comisión no se recupera aunque se gane, así que va aparte del importe.
    expect(tipos).toEqual(['DISPUTE', 'DISPUTE_FEE']);
  });

  it('envía como prueba la descarga registrada y la aceptación de la política', async () => {
    await abrir();

    const evidencia = stripe.disputes.update.mock.calls[0][1].evidence;
    expect(evidencia.access_activity_log).toContain('2026-08-01T10:05:00');
    expect(evidencia.refund_policy_disclosure).toContain('2026-08-01T09:59:00');
    expect(evidencia.customer_email_address).toBe('atleta@test.com');
  });

  it('no repite el trabajo si el webhook llega dos veces', async () => {
    prisma.order.findFirst.mockResolvedValue({ ...ORDER, stripeDisputeId: 'dp_1' });

    await abrir();

    expect(stripe.transfers.createReversal).not.toHaveBeenCalled();
    expect(prisma.order.update).not.toHaveBeenCalled();
  });

  it('ganar la disputa devuelve el pedido a pagado', async () => {
    prisma.order.findFirst.mockResolvedValue({ ...ORDER, stripeDisputeId: 'dp_1' });

    await service.handleDisputeClosed('dp_1', 'won');

    expect(prisma.order.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'PAID', disputeOutcome: 'won' }) }),
    );
  });

  it('perderla lo deja como reembolsado', async () => {
    prisma.order.findFirst.mockResolvedValue({ ...ORDER, stripeDisputeId: 'dp_1' });

    await service.handleDisputeClosed('dp_1', 'lost');

    expect(prisma.order.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'REFUNDED' }) }),
    );
  });

  it('si falla el envío de la evidencia, el dinero ya se ha recuperado igual', async () => {
    stripe.disputes.update.mockRejectedValue(new Error('Stripe caído'));

    await expect(abrir()).resolves.toBeUndefined();
    expect(stripe.transfers.createReversal).toHaveBeenCalled();
  });
});
