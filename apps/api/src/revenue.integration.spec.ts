/**
 * Cuánto se ha vendido, contra PostgreSQL real: monedas que no se mezclan,
 * ventas medidas por la fecha en que se cobraron y pedidos reembolsados que
 * dejan de contar. Solo corre con E2E_DATABASE_URL (la base debe llamarse
 * *e2e* o *test*).
 */
import { PrismaClient } from '@prisma/client';
import { UserRole } from '@shared/types';
import { AdminOrdersService } from './admin/admin-orders.service';
import { countingLedgerWhere, ledgerByTypeAndCurrency, paidInRange, primaryMoney, sumRowsByCurrency } from './common/utils/revenue';
import { e2eDatabaseUrl } from './test-support/e2e-db';

const url = e2eDatabaseUrl();
const suite = url ? describe : describe.skip;
const stamp = Date.now();

suite('ingresos contra PostgreSQL real', () => {
  let prisma: any;
  let admin: AdminOrdersService;
  let workspaceId: string;
  let eventId: string;
  let eventHnlId: string;

  // Todo el seed vive en junio de 2031 para no cruzarse con otros datos.
  const day = (d: number) => new Date(Date.UTC(2031, 5, d, 12));
  const RANGE = { from: '2031-06-01T00:00:00Z', to: '2031-06-30T23:59:59Z' };

  async function order(data: { currency: string; amountCents: number; status: string; createdAt: Date; paidAt?: Date | null; eventId?: string }) {
    return prisma.order.create({
      data: {
        eventId: data.eventId ?? eventId,
        amountCents: data.amountCents,
        currency: data.currency,
        status: data.status,
        createdAt: data.createdAt,
        paidAt: data.paidAt ?? null,
        paymentGateway: 'stripe',
        stripeSessionId: `cs_${stamp}_${Math.random()}`,
      },
    });
  }

  async function ledger(orderId: string, rows: Array<{ type: string; amountCents: number; status?: string; currency?: string }>) {
    await prisma.ledgerEntry.createMany({
      data: rows.map((row, i) => ({
        dedupeKey: `${orderId}:${row.type}:${i}`,
        orderId,
        eventId,
        workspaceId,
        type: row.type,
        status: row.status ?? 'AVAILABLE',
        amountCents: row.amountCents,
        currency: row.currency ?? 'USD',
      })),
    });
  }

  // El informe de ingresos es de toda la plataforma: la prueba vive en un
  // periodo propio (mayo-junio de 2031) y lo deja vacío antes y después.
  const purge = async () => {
    await prisma.order.deleteMany({ where: { createdAt: { gte: new Date(Date.UTC(2031, 4, 1)), lt: new Date(Date.UTC(2031, 6, 1)) } } });
  };

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url } } });
    admin = new AdminOrdersService(prisma);
    await purge();

    const user = await prisma.user.create({ data: { email: `rev-${stamp}@e2e.test`, role: 'PHOTOGRAPHER' } });
    const ws = await prisma.workspace.create({ data: { name: 'Ingresos', slug: `rev-${stamp}`, ownerId: user.id } });
    workspaceId = ws.id;
    const mk = (suffix: string, currency: string) => prisma.event.create({
      data: {
        name: `Carrera ${suffix}`, slug: `rev-${suffix}-${stamp}`, date: day(1), ownerId: user.id, workspaceId: ws.id,
        isPublished: true, pricing: { singlePhoto: 100, pack5: 400, pack10: 700, currency },
      },
    });
    eventId = (await mk('usd', 'USD')).id;
    eventHnlId = (await mk('hnl', 'HNL')).id;

    // 1) Creado el 31 de mayo, pagado el 15 de junio: es de JUNIO.
    const o1 = await order({ currency: 'USD', amountCents: 1000, status: 'PAID', createdAt: new Date(Date.UTC(2031, 4, 31, 12)), paidAt: day(15) });
    await ledger(o1.id, [
      { type: 'GROSS_SALE', amountCents: 1000 },
      { type: 'PLATFORM_FEE', amountCents: 120 },
      { type: 'PHOTOGRAPHER_EARNING', amountCents: 880 },
    ]);

    // 2) Cobrado y reembolsado: no es ingreso. Sus asientos quedan en estados distintos.
    const o2 = await order({ currency: 'USD', amountCents: 500, status: 'REFUNDED', createdAt: day(10), paidAt: day(10) });
    await ledger(o2.id, [
      { type: 'GROSS_SALE', amountCents: 500, status: 'REVERSED' },
      { type: 'PLATFORM_FEE', amountCents: 60, status: 'AVAILABLE' }, // reembolso hecho desde Stripe: sin revertir
      { type: 'PHOTOGRAPHER_EARNING', amountCents: 440, status: 'REVERSED' },
      { type: 'REFUND', amountCents: -500 },
    ]);

    // 3) Otra moneda: no se suma con los dólares.
    const o3 = await order({ currency: 'HNL', amountCents: 20000, status: 'PAID', createdAt: day(12), paidAt: day(12), eventId: eventHnlId });
    await ledger(o3.id, [{ type: 'GROSS_SALE', amountCents: 20000, currency: 'HNL' }]);

    // 4) Sin cobrar todavía.
    await order({ currency: 'USD', amountCents: 300, status: 'CREATED', createdAt: day(20) });

    // 5) Pedido antiguo, anterior a que existiera paidAt: cae a su fecha de creación.
    await order({ currency: 'USD', amountCents: 200, status: 'PAID', createdAt: day(20), paidAt: null });
  });

  afterAll(async () => {
    await purge();
    await prisma?.$disconnect();
  });

  it('no suma monedas distintas y deja fuera lo reembolsado y lo sin cobrar', async () => {
    const rows = await prisma.order.groupBy({
      by: ['currency'],
      where: { ...paidInRange(new Date(RANGE.from), new Date(RANGE.to)), event: { workspaceId } },
      _sum: { amountCents: true },
      _count: { _all: true },
    });
    const money = primaryMoney(sumRowsByCurrency(rows, (row: any) => row._sum.amountCents));

    // USD: 1000 (pagado en junio, creado en mayo) + 200 (antiguo, sin paidAt). El reembolsado y el CREATED no cuentan.
    expect(money.byCurrency).toEqual({ USD: 1200, HNL: 20000 });
    expect(money.mixedCurrencies).toBe(true);
  });

  it('un pedido se cuenta en el mes en que se cobró, no en el que se creó', async () => {
    const may = await prisma.order.count({ where: { ...paidInRange(new Date('2031-05-01T00:00:00Z'), new Date('2031-05-31T23:59:59Z')), event: { workspaceId } } });
    const june = await prisma.order.count({ where: { ...paidInRange(new Date(RANGE.from), new Date(RANGE.to)), event: { workspaceId } } });

    expect(may).toBe(0);
    expect(june).toBe(3);
  });

  it('el reparto no cuenta los pedidos reembolsados, aunque sus asientos queden en estados distintos', async () => {
    const grouped = await prisma.ledgerEntry.groupBy({
      by: ['currency', 'type'],
      where: countingLedgerWhere({ workspaceId }),
      _sum: { amountCents: true },
    });
    const byType = ledgerByTypeAndCurrency(grouped);

    // Solo el pedido 1: la venta, la comisión y el fotógrafo del reembolsado no entran.
    expect(byType.GROSS_SALE.USD).toBe(1000);
    expect(byType.PLATFORM_FEE.USD).toBe(120);
    expect(byType.PHOTOGRAPHER_EARNING.USD).toBe(880);
    expect(byType.GROSS_SALE.HNL).toBe(20000);
    // El reembolso sí se muestra, aparte.
    expect(byType.REFUND.USD).toBe(-500);
  });

  it('las estadísticas del administrador separan monedas y excluyen lo reembolsado', async () => {
    const stats: any = await admin.getOrdersStats(UserRole.ADMIN);

    // Hay otros datos en la base e2e, así que se comprueba lo que aporta este seed.
    expect(stats.revenueByCurrency.HNL).toBeGreaterThanOrEqual(20000);
    expect(stats.mixedCurrencies).toBe(true);
    expect(stats.byStatus.REFUNDED).toBeDefined();
    expect(typeof stats.currency).toBe('string');
  });

  it('el informe de ingresos agrupa por fecha de cobro y por moneda', async () => {
    const report: any[] = await admin.getRevenueReport(UserRole.ADMIN, 'monthly', RANGE.from, RANGE.to);
    const june = report.filter(row => row.period === '2031-06');

    const usd = june.find(row => row.currency === 'USD');
    const hnl = june.find(row => row.currency === 'HNL');
    expect(usd).toMatchObject({ revenue: 1200, orders: 2 });
    expect(hnl).toMatchObject({ revenue: 20000, orders: 1 });
    // Ninguna fila mezcla monedas ni cae en mayo (mes en que se creó el pedido 1).
    expect(report.some(row => row.period === '2031-05')).toBe(false);
  });
});
