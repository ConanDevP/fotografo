import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';

import { ConfigService } from '@nestjs/config';

import { BillingService } from './billing.service';
import { PrismaService } from '../common/services/prisma.service';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { PlanSubscriptionsService } from './plan-subscriptions.service';
import { UserRole } from '@shared/types';

const planSubscriptions = {
  applyPlan: jest.fn().mockResolvedValue({
    stripeSubscriptionId: null,
    stripePlanItemId: null,
    stripeStorageItemId: null,
    currentPeriodEnd: null,
    status: 'ACTIVE',
  }),
};

const GB = BigInt(1024) * BigInt(1024) * BigInt(1024);
const WORKSPACE = 'ws-1';

const arranque = {
  id: 'plan-free',
  slug: 'arranque',
  name: 'Arranque',
  priceCents: 0,
  commissionPercent: 10,
  sharePhotoCents: 2,
  includedStorageBytes: BigInt(5) * GB,
  extraStorageBlockBytes: null,
  extraStorageBlockCents: null,
  sponsoredEventFeeCents: 2500,
  allowsCustomDomain: false,
  allowsSponsors: false,
  allowsAdvancedMetrics: false,
  isDefault: true,
  isActive: true,
};

const profesional = {
  ...arranque,
  id: 'plan-pro',
  slug: 'profesional',
  name: 'Profesional',
  priceCents: 1500,
  commissionPercent: 7,
  includedStorageBytes: BigInt(100) * GB,
  extraStorageBlockBytes: BigInt(100) * GB,
  extraStorageBlockCents: 1500,
  isDefault: false,
};

describe('BillingService', () => {
  let service: BillingService;
  let prisma: any;

  /** Deja el espacio con la suscripción y el consumo indicados. */
  const givenWorkspace = (subscription: any, storageBytesUsed: bigint) =>
    prisma.workspace.findUnique.mockResolvedValue({ storageBytesUsed, subscription });

  beforeEach(async () => {
    prisma = {
      plan: { findFirst: jest.fn().mockResolvedValue(arranque), findUnique: jest.fn(), findMany: jest.fn() },
      workspace: { findUnique: jest.fn(), update: jest.fn().mockResolvedValue({}) },
      event: { findUnique: jest.fn(), update: jest.fn().mockResolvedValue({}) },
      photo: { aggregate: jest.fn(), count: jest.fn().mockResolvedValue(0) },
      subscription: { upsert: jest.fn().mockResolvedValue({}) },
      $executeRaw: jest.fn().mockResolvedValue(1),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BillingService,
        { provide: PrismaService, useValue: prisma },
        { provide: WorkspacesService, useValue: { assertAccess: jest.fn() } },
        { provide: PlanSubscriptionsService, useValue: planSubscriptions },
        { provide: ConfigService, useValue: { get: (key: string, fallback?: any) => (key === 'STRIPE_SECRET_KEY' ? 'sk_test_fake' : fallback) } },
      ],
    }).compile();

    service = module.get<BillingService>(BillingService);
  });

  describe('plan efectivo', () => {
    it('cae al plan por defecto cuando el espacio no tiene suscripción', async () => {
      givenWorkspace(null, BigInt(0));

      const result = await service.resolveForWorkspace(WORKSPACE);

      expect(result.plan.slug).toBe('arranque');
      expect(result.commissionPercent).toBe(10);
      expect(result.storageAllowanceBytes).toBe(BigInt(5) * GB);
    });

    it('suma los bloques contratados al espacio incluido en el plan', async () => {
      givenWorkspace(
        { status: 'ACTIVE', extraStorageBlocks: 3, plan: profesional },
        BigInt(0),
      );

      const result = await service.resolveForWorkspace(WORKSPACE);

      // 100 GB del plan + 3 bloques de 100 GB.
      expect(result.storageAllowanceBytes).toBe(BigInt(400) * GB);
      expect(result.commissionPercent).toBe(7);
    });

    it('degrada al plan gratuito si la suscripción está impagada', async () => {
      givenWorkspace(
        { status: 'PAST_DUE', extraStorageBlocks: 5, plan: profesional },
        BigInt(0),
      );

      const result = await service.resolveForWorkspace(WORKSPACE);

      expect(result.plan.slug).toBe('arranque');
      expect(result.commissionPercent).toBe(10);
      // Los bloques de la suscripción caída no se arrastran.
      expect(result.storageAllowanceBytes).toBe(BigInt(5) * GB);
    });

    it('no deja el espacio disponible en negativo cuando ya se pasó del cupo', async () => {
      givenWorkspace(null, BigInt(9) * GB);

      const result = await service.resolveForWorkspace(WORKSPACE);

      expect(result.storageAvailableBytes).toBe(BigInt(0));
    });

    it('falla claro si nadie ha sembrado el plan por defecto', async () => {
      prisma.plan.findFirst.mockResolvedValue(null);
      givenWorkspace(null, BigInt(0));

      await expect(service.resolveForWorkspace(WORKSPACE)).rejects.toThrow(NotFoundException);
    });
  });

  describe('cupo de almacenamiento', () => {
    it('deja subir cuando el archivo cabe justo', async () => {
      givenWorkspace(null, BigInt(5) * GB - BigInt(1000));

      await expect(service.assertStorageAvailable(WORKSPACE, 1000)).resolves.toBeUndefined();
    });

    it('bloquea la subida cuando el archivo no cabe', async () => {
      givenWorkspace(null, BigInt(5) * GB - BigInt(100));

      await expect(service.assertStorageAvailable(WORKSPACE, 1000)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('ignora la comprobación si la foto no pertenece a ningún espacio', async () => {
      await expect(service.assertStorageAvailable(null, 5_000_000)).resolves.toBeUndefined();
      expect(prisma.workspace.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('comisión para el reparto', () => {
    it('devuelve el porcentaje del plan del beneficiario', async () => {
      givenWorkspace({ status: 'ACTIVE', extraStorageBlocks: 0, plan: profesional }, BigInt(0));

      await expect(service.commissionPercentFor(WORKSPACE)).resolves.toBe(7);
    });

    it('devuelve null si el espacio no se puede resolver, para que el pago no se caiga', async () => {
      prisma.workspace.findUnique.mockResolvedValue(null);

      await expect(service.commissionPercentFor(WORKSPACE)).resolves.toBeNull();
    });

    it('devuelve null cuando la venta no tiene espacio beneficiario', async () => {
      await expect(service.commissionPercentFor(null)).resolves.toBeNull();
    });
  });

  describe('ingresos', () => {
    const givenLedger = (rows: Array<{ type: string; status: string; total: number }>) => {
      prisma.ledgerEntry = {
        groupBy: jest.fn().mockResolvedValue(
          rows.map(row => ({ type: row.type, status: row.status, _sum: { amountCents: row.total }, _count: 1 })),
        ),
        findMany: jest.fn().mockResolvedValue([]),
      };
    };

    it('separa lo transferido de lo que sigue pendiente', async () => {
      givenLedger([
        { type: 'PHOTOGRAPHER_EARNING', status: 'PAID_OUT', total: 7000 },
        { type: 'PHOTOGRAPHER_EARNING', status: 'AVAILABLE', total: 2500 },
      ]);

      const result = await service.earnings(WORKSPACE, 'user-1', UserRole.ADMIN);

      expect(result.summary.paidOutCents).toBe(7000);
      expect(result.summary.pendingCents).toBe(2500);
    });

    it('no suma al fotógrafo las comisiones de plataforma ni pasarela', async () => {
      // Si se sumaran, vería como suyo un dinero que nunca va a recibir.
      givenLedger([
        { type: 'PHOTOGRAPHER_EARNING', status: 'PAID_OUT', total: 7390 },
        { type: 'PLATFORM_FEE', status: 'PAID_OUT', total: -1200 },
        { type: 'PROCESSOR_FEE', status: 'PAID_OUT', total: -590 },
        { type: 'GROSS_SALE', status: 'PAID_OUT', total: 10000 },
      ]);

      const result = await service.earnings(WORKSPACE, 'user-1', UserRole.ADMIN);

      expect(result.summary.paidOutCents).toBe(7390);
      // Las comisiones se informan en positivo aunque se guarden en negativo.
      expect(result.summary.platformFeeCents).toBe(1200);
      expect(result.summary.processorFeeCents).toBe(590);
      expect(result.summary.grossCents).toBe(10000);
    });

    it('cuenta aparte lo retenido por un contracargo', async () => {
      givenLedger([
        { type: 'PHOTOGRAPHER_EARNING', status: 'PAID_OUT', total: 5000 },
        { type: 'PHOTOGRAPHER_EARNING', status: 'REVERSED', total: 1500 },
      ]);

      const result = await service.earnings(WORKSPACE, 'user-1', UserRole.ADMIN);

      // Lo revertido no debe seguir contando como cobrado.
      expect(result.summary.paidOutCents).toBe(5000);
      expect(result.summary.reversedCents).toBe(1500);
    });

    it('exige permiso sobre el espacio si no es administrador', async () => {
      givenLedger([]);
      const workspaces = (service as any).workspaces;
      workspaces.assertAccess.mockRejectedValueOnce(new ForbiddenException('sin acceso'));

      await expect(service.earnings(WORKSPACE, 'intruso', UserRole.ATHLETE)).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  describe('cambio de plan', () => {
    it('rechaza bajar a un plan que no cubre lo que ya ocupas', async () => {
      prisma.plan.findUnique.mockResolvedValue(arranque);
      prisma.workspace.findUnique.mockResolvedValue({ storageBytesUsed: BigInt(80) * GB });

      await expect(
        service.changePlan(WORKSPACE, 'arranque', 0, 'user-1', UserRole.ADMIN),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.subscription.upsert).not.toHaveBeenCalled();
    });

    it('acepta el cambio cuando el nuevo cupo alcanza', async () => {
      prisma.plan.findUnique.mockResolvedValue(profesional);
      prisma.workspace.findUnique.mockResolvedValue({ storageBytesUsed: BigInt(80) * GB });

      await service.changePlan(WORKSPACE, 'profesional', 1, 'user-1', UserRole.ADMIN);

      expect(prisma.subscription.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { workspaceId: WORKSPACE },
          update: expect.objectContaining({ planId: 'plan-pro', extraStorageBlocks: 1 }),
        }),
      );
    });

    it('no activa el plan si la pasarela rechaza el cobro', async () => {
      // Guardar antes de cobrar regalaría el plan en cada tarjeta rechazada.
      prisma.plan.findUnique.mockResolvedValue(profesional);
      prisma.workspace.findUnique.mockResolvedValue({ storageBytesUsed: BigInt(1) * GB });
      planSubscriptions.applyPlan.mockRejectedValueOnce(
        new BadRequestException({ code: 'SUBSCRIPTION_CHARGE_FAILED' }),
      );

      await expect(
        service.changePlan(WORKSPACE, 'profesional', 0, 'user-1', UserRole.ADMIN),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.subscription.upsert).not.toHaveBeenCalled();
    });

    it('guarda los identificadores que devuelve la pasarela', async () => {
      prisma.plan.findUnique.mockResolvedValue(profesional);
      prisma.workspace.findUnique.mockResolvedValue({ storageBytesUsed: BigInt(1) * GB });
      planSubscriptions.applyPlan.mockResolvedValueOnce({
        stripeSubscriptionId: 'sub_1',
        stripePlanItemId: 'si_plan',
        stripeStorageItemId: null,
        currentPeriodEnd: new Date('2026-09-24T00:00:00Z'),
        status: 'ACTIVE',
      });

      await service.changePlan(WORKSPACE, 'profesional', 0, 'user-1', UserRole.ADMIN);

      expect(prisma.subscription.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({ stripeSubscriptionId: 'sub_1', stripePlanItemId: 'si_plan' }),
        }),
      );
    });

    it('rechaza ampliaciones en un plan que no las admite', async () => {
      prisma.plan.findUnique.mockResolvedValue(arranque);

      await expect(
        service.changePlan(WORKSPACE, 'arranque', 2, 'user-1', UserRole.ADMIN),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('modo compartir', () => {
    it('acumula el cargo por fotografía subida según el plan', async () => {
      givenWorkspace(null, BigInt(0));

      // Plan Arranque: 2 céntimos por foto.
      await expect(service.accrueSharePhotoCharge(WORKSPACE, 10)).resolves.toBe(20);
      expect(prisma.workspace.update).toHaveBeenCalledWith({
        where: { id: WORKSPACE },
        data: { pendingShareChargeCents: { increment: 20 } },
      });
    });

    it('aplica la tarifa reducida del plan superior', async () => {
      givenWorkspace(
        { status: 'ACTIVE', extraStorageBlocks: 0, plan: { ...profesional, sharePhotoCents: 0.8 } },
        BigInt(0),
      );

      // 1 000 fotos a 0,008 $ = 8 $ = 800 céntimos.
      await expect(service.accrueSharePhotoCharge(WORKSPACE, 1000)).resolves.toBe(800);
    });

    it('no acumula nada si el plan no cobra por foto', async () => {
      givenWorkspace(
        { status: 'ACTIVE', extraStorageBlocks: 0, plan: { ...profesional, sharePhotoCents: 0 } },
        BigInt(0),
      );

      await expect(service.accrueSharePhotoCharge(WORKSPACE, 500)).resolves.toBe(0);
      expect(prisma.workspace.update).not.toHaveBeenCalled();
    });

    it('ignora fotografías sin espacio asociado', async () => {
      await expect(service.accrueSharePhotoCharge(null, 10)).resolves.toBe(0);
      expect(prisma.workspace.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('cobro al publicar', () => {
    const givenEvent = (over: any = {}) =>
      prisma.event.findUnique.mockResolvedValue({
        id: 'ev-1',
        name: 'Maratón',
        commerceMode: 'FREE',
        workspaceId: WORKSPACE,
        shareChargedAt: null,
        shareChargeCents: null,
        _count: { photos: 3000 },
        ...over,
      });

    it('calcula el importe sobre las fotografías que tiene ahora', async () => {
      givenEvent();
      givenWorkspace(null, BigInt(0));
      prisma.plan.findFirst.mockResolvedValueOnce(arranque).mockResolvedValueOnce(null);

      const estimate = await service.estimatePublication('ev-1');

      // 3 000 fotografías × 2 céntimos = 6 000 céntimos (60 $).
      expect(estimate.billable).toBe(true);
      expect(estimate.totalCents).toBe(6000);
      expect(estimate.photos).toBe(3000);
    });

    it('no cobra los eventos híbridos, que ya monetizan por comisión', async () => {
      givenEvent({ commerceMode: 'HYBRID' });

      const estimate = await service.estimatePublication('ev-1');

      expect(estimate.billable).toBe(false);
      expect(estimate.totalCents).toBe(0);
    });

    it('propone subir de plan solo si de verdad sale más barato', async () => {
      givenEvent();
      givenWorkspace(null, BigInt(0));
      prisma.plan.findFirst
        .mockResolvedValueOnce(arranque)
        // Profesional: 1 900 de mensualidad + 3 000 × 0,8 = 4 300 < 6 000.
        .mockResolvedValueOnce({ ...profesional, sharePhotoCents: 0.8, priceCents: 1900 });

      const estimate = await service.estimatePublication('ev-1');

      expect(estimate.upgrade).toMatchObject({ slug: 'profesional', totalCents: 2400 });
    });

    it('exige método de pago antes de publicar, informando del importe', async () => {
      givenEvent();
      givenWorkspace(null, BigInt(0));
      prisma.plan.findFirst.mockResolvedValue(arranque);
      prisma.workspace.findUnique.mockResolvedValue({
        storageBytesUsed: BigInt(0),
        subscription: null,
        stripeCustomerId: null,
        defaultPaymentMethodId: null,
      });

      await expect(service.chargePublication('ev-1')).rejects.toMatchObject({
        response: { code: 'PAYMENT_METHOD_REQUIRED' },
      });
      expect(prisma.event.update).not.toHaveBeenCalled();
    });

    it('en modo demo publica sin cobrar y sin marcarlo liquidado', async () => {
      const demo = await Test.createTestingModule({
        providers: [
          BillingService,
          { provide: PrismaService, useValue: prisma },
          { provide: WorkspacesService, useValue: { assertAccess: jest.fn() } },
        { provide: PlanSubscriptionsService, useValue: planSubscriptions },
          {
            provide: ConfigService,
            useValue: { get: (key: string) => (key === 'DEMO_PAYMENTS' ? 'true' : undefined) },
          },
        ],
      }).compile();
      const demoService = demo.get<BillingService>(BillingService);
      givenEvent();
      givenWorkspace(null, BigInt(0));
      prisma.plan.findFirst.mockResolvedValue(arranque);

      await demoService.chargePublication('ev-1');

      // Clave: no se estampa la liquidación, así que el importe sigue reclamable.
      expect(prisma.event.update).not.toHaveBeenCalled();
    });

    it('no vuelve a cobrar un evento ya liquidado', async () => {
      givenEvent({ shareChargedAt: new Date(), shareChargeCents: 6000 });

      await service.chargePublication('ev-1');

      expect(prisma.event.update).not.toHaveBeenCalled();
    });

    it('marca como liquidado el evento sin fotografías, sin pasar tarjeta', async () => {
      givenEvent({ _count: { photos: 0 } });
      givenWorkspace(null, BigInt(0));
      prisma.plan.findFirst.mockResolvedValue(arranque);

      await service.chargePublication('ev-1');

      expect(prisma.event.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ shareChargeCents: 0 }) }),
      );
    });
  });

  describe('formato legible', () => {
    it.each([
      [512, '512 B'],
      [5 * 1024, '5 KB'],
      [Number(BigInt(5) * GB), '5 GB'],
      [Number(BigInt(100) * GB), '100 GB'],
    ])('formatea %i como %s', (input, expected) => {
      expect(service.formatBytes(input)).toBe(expected);
    });
  });
});
