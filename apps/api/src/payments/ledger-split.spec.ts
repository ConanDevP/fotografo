import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';

import { PaymentsService } from './payments.service';
import { PrismaService } from '../common/services/prisma.service';
import { StorageService } from '../common/services/storage.service';
import { QueueService } from '../common/services/queue.service';
import { PaymentGatewayFactory } from './factories/payment-gateway.factory';
import { BillingService } from '../billing/billing.service';

/**
 * El reparto de una venta es la parte del sistema donde un error no se ve pero
 * se acumula: cada céntimo mal asignado sale del bolsillo de alguien.
 */
describe('Reparto de una venta', () => {
  let service: PaymentsService;
  let prisma: any;
  let stripeFee = 59;

  const order = (items: number[]) => ({
    id: 'ord-1',
    eventId: 'ev-1',
    currency: 'USD',
    amountCents: items.reduce((a, b) => a + b, 0),
    paymentGateway: 'stripe',
    stripeSessionId: 'cs_test_1',
    event: {
      platformFeePercent: 15,
      organizerCommissionPercent: 10,
      workspace: { id: 'ws-org', ownerId: 'user-org' },
      contributors: [],
    },
    items: items.map((priceCents, i) => ({
      id: `it-${i}`,
      priceCents,
      beneficiaryWorkspace: { id: 'ws-foto', ownerId: 'user-foto' },
    })),
  });

  const created = () => prisma.ledgerEntry.createMany.mock.calls[0][0].data as any[];
  const amount = (type: string) =>
    created().filter(e => e.type === type).reduce((sum, e) => sum + e.amountCents, 0);

  beforeEach(async () => {
    prisma = {
      order: { findUnique: jest.fn() },
      ledgerEntry: { createMany: jest.fn().mockResolvedValue({ count: 0 }) },
    };

    const stripe = {
      checkout: {
        sessions: {
          retrieve: jest.fn().mockImplementation(async () => ({
            payment_intent: { latest_charge: { balance_transaction: { fee: stripeFee } } },
          })),
        },
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentsService,
        { provide: PrismaService, useValue: prisma },
        { provide: StorageService, useValue: {} },
        { provide: QueueService, useValue: {} },
        { provide: ConfigService, useValue: { get: (_: string, d?: any) => d } },
        {
          provide: PaymentGatewayFactory,
          useValue: { createGateway: () => ({ getStripeInstance: () => stripe }) },
        },
        { provide: BillingService, useValue: { commissionPercentFor: async () => 12 } },
      ],
    }).compile();

    service = module.get<PaymentsService>(PaymentsService);
  });

  it('la venta se reparte entera: nada se pierde ni se inventa', async () => {
    stripeFee = 59;
    prisma.order.findUnique.mockResolvedValue(order([1000]));

    await (service as any).createLedgerForOrder('ord-1');

    const gross = amount('GROSS_SALE');
    const partes = amount('PROCESSOR_FEE') + amount('PLATFORM_FEE')
      + amount('ORGANIZER_COMMISSION') + amount('PHOTOGRAPHER_EARNING');
    expect(gross).toBe(1000);
    expect(partes).toBe(gross);
  });

  it('descuenta la comisión real de Stripe, no una estimada', async () => {
    stripeFee = 59;
    prisma.order.findUnique.mockResolvedValue(order([1000]));

    await (service as any).createLedgerForOrder('ord-1');

    expect(amount('PROCESSOR_FEE')).toBe(59);
    // Comisión de plataforma del plan (12%) sobre el bruto.
    expect(amount('PLATFORM_FEE')).toBe(120);
    // Al fotógrafo le llega lo que queda tras pasarela, plataforma y organizador.
    expect(amount('PHOTOGRAPHER_EARNING')).toBe(1000 - 59 - 120 - amount('ORGANIZER_COMMISSION'));
  });

  it('reparte el redondeo entre varias fotografías sin perder céntimos', async () => {
    stripeFee = 61; // no divisible entre tres
    prisma.order.findUnique.mockResolvedValue(order([333, 333, 334]));

    await (service as any).createLedgerForOrder('ord-1');

    expect(amount('PROCESSOR_FEE')).toBe(61);
    const partes = amount('PROCESSOR_FEE') + amount('PLATFORM_FEE')
      + amount('ORGANIZER_COMMISSION') + amount('PHOTOGRAPHER_EARNING');
    expect(partes).toBe(1000);
  });

  it('si Stripe no informa de su comisión, reparte sin descontarla en vez de bloquear la venta', async () => {
    stripeFee = undefined as any;
    prisma.order.findUnique.mockResolvedValue(order([1000]));

    await (service as any).createLedgerForOrder('ord-1');

    expect(created().some(e => e.type === 'PROCESSOR_FEE')).toBe(false);
    const partes = amount('PLATFORM_FEE') + amount('ORGANIZER_COMMISSION') + amount('PHOTOGRAPHER_EARNING');
    expect(partes).toBe(1000);
  });
});
