import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';

import { PaymentsService } from './payments.service';
import { PrismaService } from '../common/services/prisma.service';
import { StorageService } from '../common/services/storage.service';
import { QueueService } from '../common/services/queue.service';
import { PaymentGatewayFactory } from './factories/payment-gateway.factory';
import { BillingService } from '../billing/billing.service';

/**
 * Qué pasa cuando el comprador vuelve de pagar.
 *
 * Antes esta pantalla solo sabía leer el pedido y preguntaba una y otra vez
 * hasta que llegara el webhook. La entrega quedaba atada a una carrera que no
 * controlamos, y el comprador veía "confirmando" sobre un cobro ya hecho.
 */
describe('Confirmación al volver de la pasarela', () => {
  let service: PaymentsService;
  let prisma: any;

  const pedido = (overrides: Record<string, unknown> = {}) => ({
    id: 'ord-1',
    status: 'CREATED',
    paymentGateway: 'stripe',
    stripeSessionId: 'cs_del_pedido',
    ...overrides,
  });

  beforeEach(async () => {
    prisma = { order: { findUnique: jest.fn(), update: jest.fn() } };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentsService,
        { provide: PrismaService, useValue: prisma },
        { provide: StorageService, useValue: {} },
        { provide: QueueService, useValue: {} },
        { provide: ConfigService, useValue: { get: (_: string, d?: any) => d } },
        { provide: PaymentGatewayFactory, useValue: { createGateway: () => ({}) } },
        { provide: BillingService, useValue: {} },
      ],
    }).compile();

    service = module.get<PaymentsService>(PaymentsService);
    jest.spyOn(service as any, 'getOrder').mockResolvedValue({ id: 'ord-1', status: 'PAID' });
  });

  const conPedido = (order: any) =>
    jest.spyOn(service as any, 'getOrderWithStorage').mockResolvedValue(order);

  it('le pregunta a la pasarela en vez de esperar al webhook', async () => {
    conPedido(pedido());
    const confirmar = jest
      .spyOn(service as any, 'confirmPaymentFromWebhook')
      .mockResolvedValue({ success: true, orderId: 'ord-1' });

    await service.confirmOrder('ord-1', undefined, 'token-valido');

    expect(confirmar).toHaveBeenCalledWith('cs_del_pedido', 'stripe');
  });

  it('usa la sesión guardada en el pedido, no una que llegue de fuera', async () => {
    // La firma no acepta un session_id del cliente: quien vuelva de pagar no
    // puede presentar la sesión de otro para que se le confirme este pedido.
    conPedido(pedido());
    const confirmar = jest
      .spyOn(service as any, 'confirmPaymentFromWebhook')
      .mockResolvedValue({ success: true });

    await service.confirmOrder('ord-1', undefined, 'token-valido');

    expect(confirmar.mock.calls[0][0]).toBe('cs_del_pedido');
  });

  it('no reliquida un pedido ya pagado aunque se recargue la pantalla', async () => {
    conPedido(pedido({ status: 'PAID' }));
    const confirmar = jest.spyOn(service as any, 'confirmPaymentFromWebhook');

    await service.confirmOrder('ord-1', undefined, 'token-valido');

    expect(confirmar).not.toHaveBeenCalled();
  });

  it('no toca la pasarela si el pedido fue reembolsado', async () => {
    conPedido(pedido({ status: 'REFUNDED' }));
    const confirmar = jest.spyOn(service as any, 'confirmPaymentFromWebhook');

    await service.confirmOrder('ord-1', undefined, 'token-valido');

    expect(confirmar).not.toHaveBeenCalled();
  });

  it('exige el acceso al pedido antes de hablar con la pasarela', async () => {
    jest
      .spyOn(service as any, 'getOrderWithStorage')
      .mockRejectedValue(new Error('sin acceso'));
    const confirmar = jest.spyOn(service as any, 'confirmPaymentFromWebhook');

    await expect(service.confirmOrder('ord-1', undefined, 'token-falso')).rejects.toThrow();
    expect(confirmar).not.toHaveBeenCalled();
  });
});
