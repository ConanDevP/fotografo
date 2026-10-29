import { EnterpriseBillingService } from './enterprise-billing.service';

const NOW = new Date('2026-11-05T10:00:00Z');

function build(account: any, overrides: { usedPhotos?: number; billedUnits?: number; row?: any; stripe?: any } = {}) {
  const row = overrides.row ?? null;
  const prisma: any = {
    enterpriseAccount: { findUnique: jest.fn().mockResolvedValue(account) },
    usageLedgerEntry: { aggregate: jest.fn().mockResolvedValue({ _sum: { quantity: overrides.usedPhotos ?? 0 } }) },
    enterpriseInvoice: {
      aggregate: jest.fn().mockResolvedValue({ _sum: { units: overrides.billedUnits ?? 0 } }),
      findUnique: jest.fn().mockResolvedValue(row),
      create: jest.fn(async ({ data }: any) => ({ id: 'row-1', status: 'PENDING', stripeInvoiceId: null, ...data })),
      update: jest.fn().mockResolvedValue({}),
    },
    workspace: {
      findUnique: jest.fn().mockResolvedValue({ name: 'Cliente', stripeCustomerId: 'cus_1', owner: { email: 'o@c.com' } }),
      update: jest.fn(),
    },
  };
  const stripe = overrides.stripe ?? {
    invoices: {
      create: jest.fn().mockResolvedValue({ id: 'in_1' }),
      finalizeInvoice: jest.fn().mockResolvedValue({ id: 'in_1' }),
      sendInvoice: jest.fn().mockResolvedValue({}),
    },
    invoiceItems: { create: jest.fn().mockResolvedValue({}) },
    customers: { create: jest.fn().mockResolvedValue({ id: 'cus_new' }) },
  };
  const config: any = { get: jest.fn(() => 'sk_test_x') };
  const service = new EnterpriseBillingService(prisma, config);
  (service as any).stripe = stripe;
  return { service, prisma, stripe };
}

const BASE = {
  status: 'ACTIVE', currency: 'USD', invoiceDaysDue: 30, billingContactEmail: 'fin@c.com', businessContactEmail: null, legalName: 'Cliente SA',
  contractStart: new Date('2026-01-01T00:00:00Z'), contractEnd: null,
  annualPriceCents: 0, annualPhotoLimit: null, allowOverage: false, overagePhotoCents: null,
};

describe('EnterpriseBillingService', () => {
  it('no factura cuentas que no están activas', async () => {
    const { service } = build({ ...BASE, status: 'PILOT' });
    expect(await service.invoiceWorkspace('ws', NOW)).toEqual([]);
  });

  it('emite la cuota anual con idempotencia y la envía al cliente', async () => {
    const { service, stripe, prisma } = build({ ...BASE, annualPriceCents: 450000 });
    const [result] = await service.invoiceWorkspace('ws', NOW);
    expect(result).toMatchObject({ kind: 'ANNUAL', outcome: 'sent', amountCents: 450000, stripeInvoiceId: 'in_1' });
    expect(stripe.invoices.create).toHaveBeenCalledWith(
      expect.objectContaining({ collection_method: 'send_invoice', days_until_due: 30, customer: 'cus_1' }),
      expect.objectContaining({ idempotencyKey: 'ent-invoice-row-1' }),
    );
    expect(stripe.invoices.sendInvoice).toHaveBeenCalledWith('in_1');
    expect(prisma.enterpriseInvoice.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ kind: 'ANNUAL', periodKey: '2026-01-01' }) }),
    );
  });

  it('no vuelve a facturar un periodo ya enviado', async () => {
    const { service, stripe } = build({ ...BASE, annualPriceCents: 450000 }, { row: { id: 'r', status: 'SENT', stripeInvoiceId: 'in_old' } });
    const [result] = await service.invoiceWorkspace('ws', NOW);
    expect(result).toMatchObject({ outcome: 'already_invoiced', stripeInvoiceId: 'in_old' });
    expect(stripe.invoices.create).not.toHaveBeenCalled();
  });

  it('reintenta una fila fallida con la misma clave de idempotencia', async () => {
    const { service, stripe } = build({ ...BASE, annualPriceCents: 1000 }, { row: { id: 'row-9', status: 'FAILED', stripeInvoiceId: null } });
    await service.invoiceWorkspace('ws', NOW);
    expect(stripe.invoices.create).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ idempotencyKey: 'ent-invoice-row-9' }));
  });

  it('factura el exceso de fotografías sobre el cupo, a su precio', async () => {
    const { service, stripe } = build(
      { ...BASE, annualPhotoLimit: 1000, allowOverage: true, overagePhotoCents: 1.2 },
      { usedPhotos: 1500, billedUnits: 0 },
    );
    const results = await service.invoiceWorkspace('ws', NOW);
    const overage = results.find(r => r.kind === 'OVERAGE')!;
    expect(overage).toMatchObject({ outcome: 'sent', units: 500, amountCents: 600 }); // 500 × 1,2 ¢
    expect(stripe.invoiceItems.create).toHaveBeenCalledWith(expect.objectContaining({ amount: 600, currency: 'usd' }), expect.anything());
  });

  it('solo factura el exceso que no se ha facturado ya', async () => {
    const { service } = build(
      { ...BASE, annualPhotoLimit: 1000, allowOverage: true, overagePhotoCents: 1 },
      { usedPhotos: 1500, billedUnits: 500 },
    );
    const results = await service.invoiceWorkspace('ws', NOW);
    expect(results.find(r => r.kind === 'OVERAGE')).toMatchObject({ outcome: 'skipped' });
  });

  it('un exceso por debajo del mínimo de Stripe se arrastra al mes siguiente', async () => {
    const { service, stripe } = build(
      { ...BASE, annualPhotoLimit: 1000, allowOverage: true, overagePhotoCents: 1 },
      { usedPhotos: 1010, billedUnits: 0 },
    );
    const results = await service.invoiceWorkspace('ws', NOW);
    expect(results.find(r => r.kind === 'OVERAGE')).toMatchObject({ outcome: 'skipped', units: 10 });
    expect(stripe.invoices.create).not.toHaveBeenCalled();
  });

  it('sin exceso permitido no factura nada aunque se pase', async () => {
    const { service } = build({ ...BASE, annualPhotoLimit: 1000, allowOverage: false, overagePhotoCents: 1 }, { usedPhotos: 5000 });
    expect(await service.invoiceWorkspace('ws', NOW)).toEqual([]);
  });

  it('si Stripe falla, deja la fila en FAILED para el reintento', async () => {
    const stripe = {
      invoices: { create: jest.fn().mockRejectedValue(new Error('stripe caído')), finalizeInvoice: jest.fn(), sendInvoice: jest.fn() },
      invoiceItems: { create: jest.fn() },
      customers: { create: jest.fn() },
    };
    const { service, prisma } = build({ ...BASE, annualPriceCents: 1000 }, { stripe });
    const [result] = await service.invoiceWorkspace('ws', NOW);
    expect(result).toMatchObject({ outcome: 'failed' });
    expect(prisma.enterpriseInvoice.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED' }) }));
  });

  it('sin Stripe configurado no crea ninguna fila', async () => {
    const { service, prisma } = build({ ...BASE, annualPriceCents: 1000 });
    (service as any).stripe = null;
    const [result] = await service.invoiceWorkspace('ws', NOW);
    expect(result.outcome).toBe('no_stripe');
    expect(prisma.enterpriseInvoice.create).not.toHaveBeenCalled();
  });
});
