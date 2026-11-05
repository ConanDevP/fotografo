import { addMoney, countingLedgerWhere, paidInRange, primaryMoney, sumRowsByCurrency } from './revenue';

describe('primaryMoney', () => {
  it('sin importes devuelve cero en la moneda de reserva, sin inventar monedas', () => {
    expect(primaryMoney({}, 'HNL')).toEqual({ currency: 'HNL', cents: 0, byCurrency: {}, mixedCurrencies: false });
  });

  it('con una sola moneda, no es mixta', () => {
    expect(primaryMoney({ USD: 1200 })).toMatchObject({ currency: 'USD', cents: 1200, mixedCurrencies: false });
  });

  it('con varias, toma la de mayor volumen y avisa de que no es el total', () => {
    const money = primaryMoney({ USD: 1200, HNL: 20000 });
    expect(money).toMatchObject({ currency: 'HNL', cents: 20000, mixedCurrencies: true });
    expect(money.byCurrency).toEqual({ HNL: 20000, USD: 1200 });
  });

  it('un empate se resuelve siempre igual', () => {
    expect(primaryMoney({ MXN: 100, USD: 100 }).currency).toBe('MXN');
  });

  it('ignora monedas sin movimiento', () => {
    expect(primaryMoney({ USD: 0, HNL: 50 })).toMatchObject({ currency: 'HNL', mixedCurrencies: false });
  });
});

describe('addMoney / sumRowsByCurrency', () => {
  it('normaliza la moneda y acepta nulos', () => {
    const into: Record<string, number> = {};
    addMoney(into, 'usd', 100);
    addMoney(into, 'USD', null);
    addMoney(into, undefined, 50);
    expect(into).toEqual({ USD: 150 });
  });

  it('suma filas de un groupBy por moneda', () => {
    const rows = [{ currency: 'USD', v: 1 }, { currency: 'usd', v: 2 }, { currency: 'HNL', v: 5 }];
    expect(sumRowsByCurrency(rows, r => r.v)).toEqual({ USD: 3, HNL: 5 });
  });
});

describe('paidInRange', () => {
  it('sin rango, solo pedidos pagados', () => {
    expect(paidInRange()).toEqual({ status: 'PAID' });
  });

  it('con rango, usa la fecha de cobro y cae a la de creación en pedidos antiguos', () => {
    const start = new Date('2031-06-01');
    const end = new Date('2031-06-30');
    expect(paidInRange(start, end)).toEqual({
      status: 'PAID',
      OR: [{ paidAt: { gte: start, lte: end } }, { paidAt: null, createdAt: { gte: start, lte: end } }],
    });
  });
});

describe('countingLedgerWhere', () => {
  it('cuenta ventas de pedidos pagados y deja los ajustes aparte', () => {
    const where = countingLedgerWhere({ workspaceId: 'w' }) as any;
    expect(where.AND[0]).toEqual({ workspaceId: 'w' });
    const [revenue, adjustments] = where.AND[1].OR;
    expect(revenue.order).toEqual({ status: 'PAID' });
    expect(revenue.type.in).toContain('GROSS_SALE');
    expect(adjustments.type.in).toEqual(['REFUND', 'DISPUTE', 'DISPUTE_FEE']);
  });
});
