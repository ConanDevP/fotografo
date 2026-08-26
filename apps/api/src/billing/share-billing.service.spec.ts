import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';

import { ShareBillingService } from './share-billing.service';
import { PrismaService } from '../common/services/prisma.service';

const PERIOD = '2026-07';

// El prefijo `mock` es lo que deja a Jest usarla dentro de la factoría, que se
// eleva por encima de las declaraciones del módulo.
const mockPaymentIntents = { create: jest.fn() };
jest.mock('stripe', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({ paymentIntents: mockPaymentIntents })),
}));

const workspace = (overrides: Record<string, unknown> = {}) => ({
  id: 'ws-1',
  name: 'Estudio Rivera',
  pendingShareChargeCents: 430,
  stripeCustomerId: 'cus_1',
  defaultPaymentMethodId: 'pm_1',
  ...overrides,
});

describe('ShareBillingService', () => {
  let service: ShareBillingService;
  let prisma: any;

  const build = async (config: Record<string, string> = { STRIPE_SECRET_KEY: 'sk_test_fake' }) => {
    prisma = {
      workspace: { findMany: jest.fn().mockResolvedValue([]), update: jest.fn() },
      shareUsageCharge: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn(),
        update: jest.fn(),
      },
      $transaction: jest.fn().mockImplementation((operations: unknown[]) => Promise.resolve(operations)),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ShareBillingService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: ConfigService,
          useValue: { get: (key: string, fallback?: any) => config[key] ?? fallback },
        },
      ],
    }).compile();

    service = module.get(ShareBillingService);
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockPaymentIntents.create.mockResolvedValue({ id: 'pi_1' });
    await build();
  });

  it('cobra lo acumulado y lo descuenta del pendiente', async () => {
    prisma.workspace.findMany.mockResolvedValue([workspace()]);

    const result = await service.billPeriod(PERIOD);

    expect(result).toEqual({ charged: 1, failed: 0, skipped: 0 });
    expect(mockPaymentIntents.create).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 430, off_session: true, confirm: true }),
      expect.objectContaining({ idempotencyKey: `lucilamon-share-usage-ws-1-${PERIOD}` }),
    );
  });

  it('descuenta lo cobrado en vez de poner el pendiente a cero', async () => {
    // Durante el cobro pueden acumularse céntimos del mes siguiente; ponerlo a
    // cero los regalaría.
    prisma.workspace.findMany.mockResolvedValue([workspace()]);

    await service.billPeriod(PERIOD);

    expect(prisma.workspace.update).toHaveBeenCalledWith({
      where: { id: 'ws-1' },
      data: { pendingShareChargeCents: { decrement: 430 } },
    });
  });

  it('redondea a la baja los céntimos fraccionados', async () => {
    prisma.workspace.findMany.mockResolvedValue([workspace({ pendingShareChargeCents: 512.86 })]);

    await service.billPeriod(PERIOD);

    expect(mockPaymentIntents.create).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 512 }),
      expect.anything(),
    );
  });

  it('arrastra al mes siguiente los importes por debajo del mínimo de la pasarela', async () => {
    prisma.workspace.findMany.mockResolvedValue([workspace({ pendingShareChargeCents: 12 })]);

    const result = await service.billPeriod(PERIOD);

    expect(result.skipped).toBe(1);
    expect(mockPaymentIntents.create).not.toHaveBeenCalled();
    expect(prisma.workspace.update).not.toHaveBeenCalled();
  });

  it('no vuelve a cobrar un periodo ya pagado', async () => {
    prisma.workspace.findMany.mockResolvedValue([workspace()]);
    prisma.shareUsageCharge.findUnique.mockResolvedValue({ status: 'PAID' });

    const result = await service.billPeriod(PERIOD);

    expect(result).toEqual({ charged: 0, failed: 0, skipped: 1 });
    expect(mockPaymentIntents.create).not.toHaveBeenCalled();
  });

  it('deja el importe pendiente cuando el cobro falla', async () => {
    prisma.workspace.findMany.mockResolvedValue([workspace()]);
    mockPaymentIntents.create.mockRejectedValue(new Error('Tarjeta rechazada'));

    const result = await service.billPeriod(PERIOD);

    expect(result.failed).toBe(1);
    // Lo importante: no se descuenta nada, así que se reintenta el mes que viene.
    expect(prisma.workspace.update).not.toHaveBeenCalled();
    expect(prisma.shareUsageCharge.upsert).toHaveBeenLastCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ status: 'FAILED', failureReason: 'Tarjeta rechazada' }),
      }),
    );
  });

  it('registra el fallo cuando el espacio no tiene método de pago', async () => {
    prisma.workspace.findMany.mockResolvedValue([
      workspace({ stripeCustomerId: null, defaultPaymentMethodId: null }),
    ]);

    const result = await service.billPeriod(PERIOD);

    expect(result.failed).toBe(1);
    expect(mockPaymentIntents.create).not.toHaveBeenCalled();
    expect(prisma.workspace.update).not.toHaveBeenCalled();
  });

  it('no cobra nada con DEMO_PAYMENTS activo', async () => {
    await build({ STRIPE_SECRET_KEY: 'sk_test_fake', DEMO_PAYMENTS: 'true' });
    prisma.workspace.findMany.mockResolvedValue([workspace()]);

    const result = await service.billPeriod(PERIOD);

    expect(result.skipped).toBe(1);
    expect(mockPaymentIntents.create).not.toHaveBeenCalled();
    expect(prisma.workspace.update).not.toHaveBeenCalled();
  });

  it('factura el mes anterior, no el que corre', () => {
    expect(service.previousPeriod(new Date('2026-08-01T03:00:00Z'))).toBe('2026-07');
    // El salto de año es donde falla un cálculo ingenuo de mes.
    expect(service.previousPeriod(new Date('2026-01-15T03:00:00Z'))).toBe('2025-12');
  });
});
