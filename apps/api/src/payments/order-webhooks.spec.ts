import { PaymentsService } from './payments.service';

/** El cambio de estado de un pedido avisa por webhook al socio: solo cuando de verdad cambia. */
function build(currentStatus: string) {
  const svc: any = Object.create(PaymentsService.prototype);
  svc.prisma = {
    order: {
      findUnique: jest.fn().mockResolvedValue({ stripeSessionId: null, status: currentStatus, paymentGateway: 'PAYPAL' }),
      update: jest.fn().mockResolvedValue({}),
    },
  };
  svc.createLedgerForOrder = jest.fn().mockResolvedValue(undefined);
  svc.recordPurchaseMetric = jest.fn().mockResolvedValue(undefined);
  svc.settleStripeOrder = jest.fn().mockResolvedValue(undefined);
  svc.partnerCommerce = { emitOrderEvent: jest.fn().mockResolvedValue(undefined) };
  return svc;
}

describe('aviso order.paid', () => {
  it('se emite cuando el pedido pasa a pagado, tras crear sus asientos', async () => {
    const svc = build('CREATED');
    await svc.markOrderPaid('o-1', 'pay-1');
    expect(svc.partnerCommerce.emitOrderEvent).toHaveBeenCalledWith('o-1', 'order.paid');
    expect(svc.createLedgerForOrder.mock.invocationCallOrder[0]).toBeLessThan(svc.partnerCommerce.emitOrderEvent.mock.invocationCallOrder[0]);
  });

  it('no se repite si el pedido ya estaba pagado (el webhook de la pasarela puede llegar dos veces)', async () => {
    const svc = build('PAID');
    await svc.markOrderPaid('o-1', 'pay-1');
    expect(svc.partnerCommerce.emitOrderEvent).not.toHaveBeenCalled();
  });

  it('funciona aunque no haya servicio de avisos (el worker no lo tiene)', async () => {
    const svc = build('CREATED');
    svc.partnerCommerce = undefined;
    await expect(svc.markOrderPaid('o-1', 'pay-1')).resolves.toBeUndefined();
  });
});
