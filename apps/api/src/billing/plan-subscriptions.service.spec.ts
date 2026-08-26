import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PlanSubscriptionsService } from './plan-subscriptions.service';
import { PrismaService } from '../common/services/prisma.service';

const mockSubscriptions = { create: jest.fn(), update: jest.fn(), del: jest.fn() };
jest.mock('stripe', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({ subscriptions: mockSubscriptions })),
}));

const GB = BigInt(1024) * BigInt(1024) * BigInt(1024);

const free: any = {
  id: 'plan-free',
  slug: 'arranque',
  name: 'Arranque',
  priceCents: 0,
  currency: 'USD',
  includedStorageBytes: BigInt(5) * GB,
  extraStorageBlockBytes: null,
  extraStorageBlockCents: null,
  stripePriceId: null,
  stripeStoragePriceId: null,
  isDefault: true,
  isActive: true,
};

const pro: any = {
  ...free,
  id: 'plan-pro',
  slug: 'profesional',
  name: 'Profesional',
  priceCents: 1900,
  extraStorageBlockBytes: BigInt(100) * GB,
  extraStorageBlockCents: 1500,
  stripePriceId: 'price_plan',
  stripeStoragePriceId: 'price_storage',
  isDefault: false,
};

const stripeSubscription = (items: Array<{ id: string; priceId: string }>) => ({
  id: 'sub_1',
  status: 'active',
  current_period_end: 1793000000,
  cancel_at_period_end: false,
  items: { data: items.map(item => ({ id: item.id, price: { id: item.priceId } })) },
});

describe('PlanSubscriptionsService', () => {
  let service: PlanSubscriptionsService;
  let prisma: any;

  const build = async (config: Record<string, string> = { STRIPE_SECRET_KEY: 'sk_test_fake' }) => {
    prisma = {
      subscription: { findUnique: jest.fn().mockResolvedValue(null), update: jest.fn() },
      workspace: {
        findUnique: jest.fn().mockResolvedValue({
          stripeCustomerId: 'cus_1',
          defaultPaymentMethodId: 'pm_1',
        }),
      },
      plan: { findFirst: jest.fn().mockResolvedValue(free), findMany: jest.fn(), update: jest.fn() },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PlanSubscriptionsService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: ConfigService,
          useValue: { get: (key: string, fallback?: any) => config[key] ?? fallback },
        },
      ],
    }).compile();

    service = module.get(PlanSubscriptionsService);
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockSubscriptions.create.mockResolvedValue(stripeSubscription([{ id: 'si_plan', priceId: 'price_plan' }]));
    mockSubscriptions.update.mockResolvedValue(stripeSubscription([{ id: 'si_plan', priceId: 'price_plan' }]));
    await build();
  });

  describe('alta', () => {
    it('crea la suscripción con la tarjeta guardada y devuelve sus ids', async () => {
      const result = await service.applyPlan('ws-1', pro, 0);

      expect(mockSubscriptions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          customer: 'cus_1',
          default_payment_method: 'pm_1',
          items: [{ price: 'price_plan' }],
          // Sin esto una tarjeta rechazada dejaría la suscripción incompleta y
          // el plan activo sin haber cobrado.
          payment_behavior: 'error_if_incomplete',
        }),
      );
      expect(result.stripeSubscriptionId).toBe('sub_1');
      expect(result.stripePlanItemId).toBe('si_plan');
      expect(result.status).toBe('ACTIVE');
    });

    it('añade el almacenamiento como segunda línea con la cantidad contratada', async () => {
      await service.applyPlan('ws-1', pro, 3);

      expect(mockSubscriptions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          items: [{ price: 'price_plan' }, { price: 'price_storage', quantity: 3 }],
        }),
      );
    });

    it('exige método de pago antes de activar un plan de pago', async () => {
      prisma.workspace.findUnique.mockResolvedValue({
        stripeCustomerId: null,
        defaultPaymentMethodId: null,
      });

      await expect(service.applyPlan('ws-1', pro, 0)).rejects.toMatchObject({
        response: { code: 'PAYMENT_METHOD_REQUIRED' },
      });
      expect(mockSubscriptions.create).not.toHaveBeenCalled();
    });

    it('se niega a activar un plan que no está sincronizado con la pasarela', async () => {
      await expect(service.applyPlan('ws-1', { ...pro, stripePriceId: null }, 0)).rejects.toMatchObject({
        response: { code: 'PLAN_NOT_SYNCED' },
      });
    });

    it('convierte el rechazo de la tarjeta en un error con causa', async () => {
      mockSubscriptions.create.mockRejectedValue(new Error('Your card was declined'));

      await expect(service.applyPlan('ws-1', pro, 0)).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('cambio y baja', () => {
    it('reutiliza la línea existente al cambiar de plan', async () => {
      prisma.subscription.findUnique.mockResolvedValue({
        stripeSubscriptionId: 'sub_1',
        stripePlanItemId: 'si_plan',
        stripeStorageItemId: null,
      });

      await service.applyPlan('ws-1', pro, 0);

      expect(mockSubscriptions.update).toHaveBeenCalledWith(
        'sub_1',
        expect.objectContaining({ items: [{ id: 'si_plan', price: 'price_plan' }] }),
      );
      expect(mockSubscriptions.create).not.toHaveBeenCalled();
    });

    it('borra la línea de almacenamiento al soltar las ampliaciones', async () => {
      prisma.subscription.findUnique.mockResolvedValue({
        stripeSubscriptionId: 'sub_1',
        stripePlanItemId: 'si_plan',
        stripeStorageItemId: 'si_storage',
      });

      await service.applyPlan('ws-1', pro, 0);

      expect(mockSubscriptions.update).toHaveBeenCalledWith(
        'sub_1',
        expect.objectContaining({
          items: expect.arrayContaining([{ id: 'si_storage', deleted: true }]),
        }),
      );
    });

    it('cancela en Stripe al bajar al plan gratuito', async () => {
      prisma.subscription.findUnique.mockResolvedValue({
        stripeSubscriptionId: 'sub_1',
        stripePlanItemId: 'si_plan',
        stripeStorageItemId: null,
      });

      const result = await service.applyPlan('ws-1', free, 0);

      expect(mockSubscriptions.del).toHaveBeenCalledWith('sub_1');
      expect(result.stripeSubscriptionId).toBeNull();
    });

    it('no toca la pasarela para un plan gratuito sin suscripción previa', async () => {
      const result = await service.applyPlan('ws-1', free, 0);

      expect(mockSubscriptions.create).not.toHaveBeenCalled();
      expect(mockSubscriptions.del).not.toHaveBeenCalled();
      expect(result.stripeSubscriptionId).toBeNull();
    });

    it('no crea suscripción con DEMO_PAYMENTS activo', async () => {
      await build({ STRIPE_SECRET_KEY: 'sk_test_fake', DEMO_PAYMENTS: 'true' });

      const result = await service.applyPlan('ws-1', pro, 0);

      expect(mockSubscriptions.create).not.toHaveBeenCalled();
      expect(result.stripeSubscriptionId).toBeNull();
    });
  });

  describe('impago', () => {
    it('baja al plan gratuito cuando Stripe agota los reintentos', async () => {
      prisma.subscription.findUnique.mockResolvedValue({
        id: 'sub-local',
        workspaceId: 'ws-1',
        planId: 'plan-pro',
      });

      await service.downgradeToFreePlan('sub_1');

      expect(prisma.subscription.update).toHaveBeenCalledWith({
        where: { id: 'sub-local' },
        data: expect.objectContaining({
          planId: 'plan-free',
          status: 'ACTIVE',
          extraStorageBlocks: 0,
          stripeSubscriptionId: null,
        }),
      });
    });

    it('deja en PAST_DUE si no hay plan gratuito que asignar', async () => {
      prisma.subscription.findUnique.mockResolvedValue({
        id: 'sub-local',
        workspaceId: 'ws-1',
        planId: 'plan-pro',
      });
      prisma.plan.findFirst.mockResolvedValue(null);

      await service.downgradeToFreePlan('sub_1');

      expect(prisma.subscription.update).toHaveBeenCalledWith({
        where: { id: 'sub-local' },
        data: { status: 'PAST_DUE' },
      });
    });

    it('un cobro fallido solo marca PAST_DUE, sin bajar de plan todavía', async () => {
      prisma.subscription.findUnique.mockResolvedValue({ id: 'sub-local', workspaceId: 'ws-1' });

      await service.markPastDue('sub_1');

      expect(prisma.subscription.update).toHaveBeenCalledWith({
        where: { id: 'sub-local' },
        data: { status: 'PAST_DUE' },
      });
    });

    it('ignora webhooks de suscripciones que no conoce', async () => {
      prisma.subscription.findUnique.mockResolvedValue(null);

      await service.downgradeToFreePlan('sub_ajena');
      await service.markPastDue('sub_ajena');

      expect(prisma.subscription.update).not.toHaveBeenCalled();
    });
  });
});
