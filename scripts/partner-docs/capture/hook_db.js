const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient({ datasources: { db: { url: 'postgresql://postgres:docs@localhost:55433/lm_docs_test' } } });
(async () => {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === 'sink') { await prisma.partnerWebhookEndpoint.update({ where: { id: arg }, data: { url: 'https://hook.invalid/lucilamon' } }); console.log('ok'); }
  if (cmd === 'limits') {
    const rows = await prisma.$queryRaw`SELECT COUNT(*)::int AS n FROM events WHERE workspace_id = ${arg}::uuid`;
    await prisma.enterpriseAccount.update({ where: { workspaceId: arg }, data: { annualEventLimit: rows[0].n, annualPhotoLimit: 0, allowOverage: false } });
    console.log('ok');
  }
  if (cmd === 'orders') {
    const [workspaceId, eventId, photoId] = [process.argv[3], process.argv[4], process.argv[5]];
    const mk = async (status, amount, extra = {}) => prisma.order.create({ data: { eventId, amountCents: amount, currency: 'USD', status, paymentGateway: 'STRIPE', guestEmail: 'corredor@example.com', paidAt: new Date(), settlementStatus: status === 'PAID' ? 'SETTLED' : 'NOT_REQUIRED', settledAt: new Date(), items: { create: [{ photoId, itemType: 'PHOTO', priceCents: amount }] }, ...extra } });
    const paid = await mk('PAID', 800);
    const refunded = await mk('REFUNDED', 3000, { refundedAt: new Date() });
    const entries = (order, gross, fee, platform, earning, status) => [
      { dedupeKey: `${order.id}:gross`, orderId: order.id, eventId, workspaceId, type: 'GROSS_SALE', status: 'AVAILABLE', amountCents: gross },
      { dedupeKey: `${order.id}:fee`, orderId: order.id, eventId, type: 'PROCESSOR_FEE', status: 'AVAILABLE', amountCents: fee },
      { dedupeKey: `${order.id}:platform`, orderId: order.id, eventId, type: 'PLATFORM_FEE', status: 'AVAILABLE', amountCents: platform },
      { dedupeKey: `${order.id}:earning`, orderId: order.id, eventId, workspaceId, type: 'PHOTOGRAPHER_EARNING', status, amountCents: earning },
    ];
    await prisma.ledgerEntry.createMany({ data: [...entries(paid, 800, 54, 48, 698, 'PAID_OUT'), ...entries(refunded, 3000, 117, 180, 2703, 'REVERSED'),
      { dedupeKey: `${refunded.id}:refund`, orderId: refunded.id, eventId, type: 'REFUND', status: 'AVAILABLE', amountCents: -3000 }] });
    console.log(JSON.stringify({ paid: paid.id, refunded: refunded.id }));
  }
  if (cmd === 'dump') {
    const rows = await prisma.partnerWebhookDelivery.findMany({ orderBy: { createdAt: 'asc' } });
    console.log(JSON.stringify(rows.map(r => ({ eventType: r.eventType, eventId: r.eventId, createdAt: r.createdAt, payload: r.payload })), null, 1));
  }
  await prisma.$disconnect();
})();
