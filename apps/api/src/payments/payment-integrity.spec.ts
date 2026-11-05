import { PaymentsService } from './payments.service';
import { StripeGatewayService } from './gateways/stripe-gateway.service';
import { PaymentStatus } from '@shared/payment-types';

/**
 * Integridad del dinero en el camino de compra.
 *
 * Cada caso nació de un fallo real que se veía leyendo el código: un evento
 * duplicado hacia los socios, un pedido cobrado que se queda sin entregar sin
 * dejar rastro, reembolsos que no descuentan, comisiones perdidas.
 */

function service(overrides: Record<string, unknown> = {}) {
  const svc: any = Object.create(PaymentsService.prototype);
  svc.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  svc.partnerCommerce = { emitOrderEvent: jest.fn().mockResolvedValue(undefined) };
  svc.createLedgerForOrder = jest.fn().mockResolvedValue(undefined);
  svc.recordPurchaseMetric = jest.fn().mockResolvedValue(undefined);
  svc.settleStripeOrder = jest.fn().mockResolvedValue(undefined);
  Object.assign(svc, overrides);
  return svc;
}

describe('markOrderPaid', () => {
  it('con dos confirmaciones a la vez (webhook y vuelta del comprador) avisa al socio una sola vez', async () => {
    // Las dos leen "CREATED"; solo una consigue el cambio a "PAID".
    let claimed = false;
    const svc = service({
      prisma: {
        order: {
          findUnique: jest.fn().mockResolvedValue({ stripeSessionId: 's', status: 'CREATED', paymentGateway: 'stripe' }),
          updateMany: jest.fn().mockImplementation(async () => {
            if (claimed) return { count: 0 };
            claimed = true;
            return { count: 1 };
          }),
          update: jest.fn().mockResolvedValue({}),
        },
      },
    });

    await Promise.all([svc.markOrderPaid('o-1', 'pi_1'), svc.markOrderPaid('o-1', 'pi_1')]);

    expect(svc.partnerCommerce.emitOrderEvent).toHaveBeenCalledTimes(1);
    expect(svc.partnerCommerce.emitOrderEvent).toHaveBeenCalledWith('o-1', 'order.paid');
  });

  it('un pedido en disputa no vuelve a "pagado" porque llegue otra confirmación', async () => {
    const svc = service({
      prisma: {
        order: {
          findUnique: jest.fn().mockResolvedValue({ stripeSessionId: 's', status: 'DISPUTED', paymentGateway: 'stripe' }),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          update: jest.fn().mockResolvedValue({}),
        },
      },
    });

    await expect(svc.markOrderPaid('o-1', 'pi_1')).rejects.toThrow();
    expect(svc.partnerCommerce.emitOrderEvent).not.toHaveBeenCalled();
  });

  it('solo reclama pedidos que aún no se han cobrado', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const svc = service({
      prisma: {
        order: {
          findUnique: jest.fn().mockResolvedValue({ stripeSessionId: 's', status: 'CREATED', paymentGateway: 'stripe' }),
          updateMany,
          update: jest.fn().mockResolvedValue({}),
        },
      },
    });

    await svc.markOrderPaid('o-1', 'pi_1');

    expect(updateMany.mock.calls[0][0].where.status).toEqual({ in: ['CREATED', 'CANCELLED'] });
  });
});

describe('Cobro que no coincide con el pedido', () => {
  const order = { id: 'o-1', status: 'CREATED', amountCents: 1000, currency: 'USD', paymentGateway: 'stripe', items: [], event: { name: 'Carrera' }, user: null };

  function build(confirmation: Record<string, unknown>) {
    const auditCreate = jest.fn().mockResolvedValue({});
    const svc = service({
      prisma: {
        order: {
          findFirst: jest.fn().mockResolvedValue(order),
          update: jest.fn().mockResolvedValue({}),
        },
        auditLog: { create: auditCreate, findFirst: jest.fn().mockResolvedValue(null) },
      },
      paymentGatewayFactory: {
        createGateway: () => ({ confirmPayment: jest.fn().mockResolvedValue({ status: PaymentStatus.APPROVED, ...confirmation }) }),
      },
      queueOrderConfirmation: jest.fn(),
    });
    svc.markOrderPaid = jest.fn().mockResolvedValue(undefined);
    return { svc, auditCreate };
  }

  it('si el importe cobrado difiere, no entrega pero deja constancia para poder resolverlo', async () => {
    const { svc, auditCreate } = build({ paidAmount: 1500, paidCurrency: 'USD' });

    const result = await svc.confirmPaymentFromWebhook('cs_1', 'stripe');

    expect(result.success).toBe(false);
    expect(svc.markOrderPaid).not.toHaveBeenCalled();
    expect(auditCreate).toHaveBeenCalledTimes(1);
    expect(auditCreate.mock.calls[0][0].data.action).toBe('PAYMENT_MISMATCH');
    expect(auditCreate.mock.calls[0][0].data.data).toMatchObject({ orderId: 'o-1', expectedCents: 1000, paidCents: 1500 });
  });

  it('si la moneda difiere, también deja constancia', async () => {
    const { svc, auditCreate } = build({ paidAmount: 1000, paidCurrency: 'MXN' });

    const result = await svc.confirmPaymentFromWebhook('cs_1', 'stripe');

    expect(result.success).toBe(false);
    expect(auditCreate).toHaveBeenCalledTimes(1);
  });

  it('un cobro correcto sigue su curso sin ruido', async () => {
    const { svc, auditCreate } = build({ paidAmount: 1000, paidCurrency: 'USD' });

    const result = await svc.confirmPaymentFromWebhook('cs_1', 'stripe');

    expect(result.success).toBe(true);
    expect(svc.markOrderPaid).toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
  });
});

describe('Importe cobrado por Stripe', () => {
  function gateway(session: Record<string, unknown>) {
    const gw: any = Object.create(StripeGatewayService.prototype);
    gw.logger = { log: jest.fn(), error: jest.fn(), warn: jest.fn() };
    gw.stripe = { checkout: { sessions: { retrieve: jest.fn().mockResolvedValue(session) } } };
    return gw as StripeGatewayService;
  }

  it('compara el precio sin impuestos: si Stripe añade IVA, el pedido no se queda sin entregar', async () => {
    const gw = gateway({
      payment_status: 'paid',
      amount_total: 1080,
      total_details: { amount_tax: 80 },
      currency: 'usd',
      metadata: { orderId: 'o-1' },
      payment_intent: { id: 'pi_1' },
    });

    const confirmation = await gw.confirmPayment('cs_1');

    expect(confirmation.paidAmount).toBe(1000);
  });

  it('sin impuestos el importe es el total de siempre', async () => {
    const gw = gateway({
      payment_status: 'paid',
      amount_total: 1000,
      currency: 'usd',
      metadata: { orderId: 'o-1' },
      payment_intent: { id: 'pi_1' },
    });

    expect((await gw.confirmPayment('cs_1')).paidAmount).toBe(1000);
  });
});

describe('Reembolso hecho desde el panel de Stripe', () => {
  it('revierte los asientos del reparto para que no queden como pendientes de pago', async () => {
    const ledgerUpdateMany = jest.fn().mockResolvedValue({ count: 3 });
    const svc = service({
      prisma: {
        order: {
          findFirst: jest.fn().mockResolvedValue({ id: 'o-1', eventId: 'e-1', currency: 'USD', amountCents: 1000, refundRequestedAt: null }),
          update: jest.fn().mockResolvedValue({}),
        },
        ledgerEntry: { createMany: jest.fn().mockResolvedValue({ count: 1 }), updateMany: ledgerUpdateMany },
      },
      reverseTransfersForOrder: jest.fn().mockResolvedValue([]),
      paymentGatewayFactory: {
        createGateway: () => ({
          getStripeInstance: () => ({
            charges: { retrieve: jest.fn().mockResolvedValue({ amount_refunded: 1000, payment_intent: 'pi_1' }) },
            checkout: { sessions: { list: jest.fn().mockResolvedValue({ data: [{ id: 'cs_1' }] }) } },
          }),
        }),
      },
    });

    await svc.syncStripeRefund({ id: 're_1', status: 'succeeded', amount: 1000, charge: 'ch_1' });

    expect(ledgerUpdateMany).toHaveBeenCalled();
    const call = ledgerUpdateMany.mock.calls[0][0];
    expect(call.where.orderId).toBe('o-1');
    expect(call.data.status).toBe('REVERSED');
    // No se revierte el propio asiento del reembolso.
    expect(JSON.stringify(call.where)).toContain('REFUND');
  });
});

describe('Comisión de Stripe al repartir', () => {
  const order = {
    id: 'ord-1', eventId: 'ev-1', currency: 'USD', amountCents: 1000, paymentGateway: 'stripe', stripeSessionId: 'cs_1',
    event: { platformFeePercent: 15, organizerCommissionPercent: 0, workspace: { id: 'ws', ownerId: 'u' }, contributors: [] },
    items: [{ id: 'it', priceCents: 1000, beneficiaryWorkspace: { id: 'ws', ownerId: 'u' } }],
  };

  it('si la comisión aún no está disponible en el primer intento, la reintenta en vez de repartir sin ella', async () => {
    const createMany = jest.fn().mockResolvedValue({ count: 0 });
    const retrieve = jest.fn()
      .mockResolvedValueOnce({ payment_intent: { latest_charge: { balance_transaction: null } } })
      .mockResolvedValue({ payment_intent: { latest_charge: { balance_transaction: { fee: 59 } } } });
    const svc = service({
      prisma: { order: { findUnique: jest.fn().mockResolvedValue(order) }, ledgerEntry: { createMany } },
      billingService: { commissionPercentFor: async () => 12 },
      paymentGatewayFactory: { createGateway: () => ({ getStripeInstance: () => ({ checkout: { sessions: { retrieve } } }) }) },
      feeRetryDelayMs: 0,
    });
    delete svc.createLedgerForOrder; // se prueba la función real, no el doble

    await svc.createLedgerForOrder('ord-1');

    const entries = createMany.mock.calls[0][0].data as any[];
    expect(retrieve).toHaveBeenCalledTimes(2);
    expect(entries.find(e => e.type === 'PROCESSOR_FEE')?.amountCents).toBe(59);
  });

  it('con una foto tan barata que las comisiones la superan, nadie queda con importe negativo y el reparto no excede lo cobrado', async () => {
    const cheap = { ...order, amountCents: 20, items: [{ id: 'it', priceCents: 20, beneficiaryWorkspace: { id: 'ws', ownerId: 'u' } }] };
    const createMany = jest.fn().mockResolvedValue({ count: 0 });
    const retrieve = jest.fn().mockResolvedValue({ payment_intent: { latest_charge: { balance_transaction: { fee: 59 } } } });
    const svc = service({
      prisma: { order: { findUnique: jest.fn().mockResolvedValue(cheap) }, ledgerEntry: { createMany } },
      billingService: { commissionPercentFor: async () => 12 },
      paymentGatewayFactory: { createGateway: () => ({ getStripeInstance: () => ({ checkout: { sessions: { retrieve } } }) }) },
      feeRetryDelayMs: 0,
    });
    delete svc.createLedgerForOrder;

    await svc.createLedgerForOrder('ord-1');

    const entries = createMany.mock.calls[0][0].data as any[];
    const sum = (type: string) => entries.filter(e => e.type === type).reduce((a, e) => a + e.amountCents, 0);
    expect(entries.every(e => e.amountCents >= 0)).toBe(true);
    // Lo que se reparte a personas (plataforma, organizador, fotógrafo) no supera el bruto.
    expect(sum('PLATFORM_FEE') + sum('ORGANIZER_COMMISSION') + sum('PHOTOGRAPHER_EARNING')).toBeLessThanOrEqual(20);
    // La comisión real se anota entera para que el libro cuadre con el banco.
    expect(sum('PROCESSOR_FEE')).toBe(59);
  });
});
