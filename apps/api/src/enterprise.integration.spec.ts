/**
 * Prueba de integración contra PostgreSQL real (con las migraciones aplicadas).
 * Solo corre si defines E2E_DATABASE_URL; nunca apuntes esa variable a una base con datos.
 *
 *   E2E_DATABASE_URL=postgresql://postgres:e2e@localhost:55432/lm_e2e npx jest enterprise.integration
 */
import { PrismaClient } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { MeteringService } from './billing/metering.service';
import { EnterpriseBillingService } from './partner-api/enterprise-billing.service';
import { EnterpriseAccessService } from './partner-api/enterprise-access.service';
import { UsageAlertsService } from './partner-api/usage-alerts.service';

import { e2eDatabaseUrl } from './test-support/e2e-db';

const url = e2eDatabaseUrl();
const stamp = Date.now();
const suite = url ? describe : describe.skip;

suite('contrato Enterprise contra PostgreSQL real', () => {
  let prisma: any;
  let metering: MeteringService;
  let workspaceId: string;
  let guestWorkspaceId: string;
  let eventId: string;
  const start = new Date(Date.now() - 10 * 24 * 3600 * 1000);

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url } } });
    // El mismo filtro de borrado lógico que PrismaService: es justo lo que tiene que sortear el conteo de eventos.
    prisma.$use(async (params: any, next: any) => {
      if (params.model === 'Event' && ['findFirst', 'findUnique', 'findMany', 'count'].includes(params.action)) {
        params.args = params.args || {};
        params.args.where = params.args.where || {};
        if (params.args.where.deletedAt === undefined) params.args.where.deletedAt = null;
      }
      return next(params);
    });
    metering = new MeteringService(prisma);

    const owner = await prisma.user.create({ data: { email: `org-${Date.now()}@e2e.test`, role: 'PHOTOGRAPHER' } });
    const guest = await prisma.user.create({ data: { email: `guest-${Date.now()}@e2e.test`, role: 'PHOTOGRAPHER' } });
    const ws = await prisma.workspace.create({ data: { name: 'Cronos E2E', slug: `cronos-${Date.now()}`, ownerId: owner.id } });
    const gws = await prisma.workspace.create({ data: { name: 'Invitado E2E', slug: `invitado-${Date.now()}`, ownerId: guest.id } });
    workspaceId = ws.id;
    guestWorkspaceId = gws.id;
    await prisma.enterpriseAccount.create({
      data: {
        workspaceId, status: 'ACTIVE', contractStart: start, annualPriceCents: 100000, currency: 'USD',
        partnerApiEnabled: true, annualPhotoLimit: 3, allowOverage: true, overagePhotoCents: 50,
        annualEventLimit: 2, billingContactEmail: 'facturas@e2e.test',
      },
    });
    const event = await prisma.event.create({ data: { name: 'Maratón E2E', slug: `maraton-${Date.now()}`, date: new Date(), ownerId: owner.id, workspaceId } });
    eventId = event.id;
  });

  afterAll(async () => { await prisma?.$disconnect(); });

  it('las fotos de un fotógrafo invitado se imputan al contrato del organizador', async () => {
    expect(await metering.meteredWorkspace(eventId, guestWorkspaceId)).toBe(workspaceId);
  });

  it('el libro de créditos cuenta una vez cada foto y el cupo se agota', async () => {
    for (let i = 0; i < 3; i++) {
      const photo = await prisma.photo.create({ data: { eventId, photographerWorkspaceId: guestWorkspaceId, cloudinaryId: `e2e-${i}`, originalUrl: `r2://x/${i}`, status: 'PENDING' } });
      const photoId = photo.id;
      await metering.recordPhoto(workspaceId, photoId, eventId);
      await metering.recordPhoto(workspaceId, photoId, eventId); // idempotente
    }
    const allowance = await metering.photoAllowance(workspaceId);
    expect(allowance.used).toBe(3);
    expect(allowance.overage).toBe(true); // el contrato permite exceso: no bloquea, factura
  });

  it('con exceso permitido se factura lo que sobra, una sola vez', async () => {
    const photo = await prisma.photo.create({ data: { eventId, cloudinaryId: 'e2e-extra', originalUrl: 'r2://x/extra', status: 'PENDING' } });
    await metering.recordPhoto(workspaceId, photo.id, eventId);

    let seq = 0;
    const stripe = {
      customers: { create: jest.fn().mockResolvedValue({ id: `cus_e2e_${stamp}` }) },
      invoices: {
        create: jest.fn().mockImplementation(async () => ({ id: `in_e2e_${stamp}_${++seq}` })),
        finalizeInvoice: jest.fn().mockImplementation(async (id: string) => ({ id })),
        sendInvoice: jest.fn().mockResolvedValue({}),
      },
      invoiceItems: { create: jest.fn().mockResolvedValue({}) },
    };
    const billing = new EnterpriseBillingService(prisma, { get: () => 'sk_test_fake' } as unknown as ConfigService);
    (billing as any).stripe = stripe;

    // Primer día del mes siguiente: el exceso del mes en curso ya es facturable.
    const nextMonth = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 2));
    const first = await billing.invoiceWorkspace(workspaceId, nextMonth);
    const second = await billing.invoiceWorkspace(workspaceId, nextMonth);

    expect(first.find(r => r.kind === 'ANNUAL')?.outcome).toBe('sent');
    // 4 fotos - 3 de cupo = 1 de exceso × 0,50 $ = 50 centavos: justo el mínimo que Stripe acepta.
    expect(first.find(r => r.kind === 'OVERAGE')).toMatchObject({ outcome: 'sent', units: 1, amountCents: 50 });
    // Repetir el cron no vuelve a facturar nada.
    expect(second.find(r => r.kind === 'ANNUAL')?.outcome).toBe('already_invoiced');
    expect(second.find(r => r.kind === 'OVERAGE')?.outcome).toBe('skipped');
    expect(stripe.invoices.create).toHaveBeenCalledTimes(2);
    expect(await prisma.enterpriseInvoice.count({ where: { workspaceId } })).toBe(2);
  });

  it('el límite de eventos cuenta también los borrados', async () => {
    await metering.assertEventCapacity(workspaceId); // lleva 1 de 2
    const second = await prisma.event.create({ data: { name: 'Segundo', slug: `seg-${Date.now()}`, date: new Date(), ownerId: (await prisma.workspace.findUnique({ where: { id: workspaceId } })).ownerId, workspaceId } });
    await prisma.event.update({ where: { id: second.id }, data: { deletedAt: new Date() } });
    await expect(metering.assertEventCapacity(workspaceId)).rejects.toMatchObject({ response: expect.objectContaining({ code: 'EVENT_LIMIT_REACHED', used: 2 }) });
  });

  it('el uso de la API se registra aunque el contrato no tenga tope', async () => {
    const access = new EnterpriseAccessService(prisma, { get: jest.fn() } as any);
    await access.authorizeExistingClient(workspaceId, ['events:read'], ['events:read'], 'LIVE');
    await access.authorizeExistingClient(workspaceId, ['events:read'], ['events:read'], 'LIVE');
    const period = new Date().toISOString().slice(0, 7);
    const row = await prisma.partnerApiUsage.findUnique({ where: { workspaceId_period: { workspaceId, period } } });
    expect(Number(row.requestCount)).toBe(2);
  });

  it('un aviso de uso no se repite aunque el job corra dos veces', async () => {
    await prisma.enterpriseAccount.update({ where: { workspaceId }, data: { monthlyApiRequestLimit: 2 } });
    const mailer = { send: jest.fn().mockResolvedValue(true) };
    const webhooks = { emit: jest.fn().mockResolvedValue(undefined) };
    const alerts = new UsageAlertsService(prisma, webhooks as any, mailer as any);
    await alerts.run();
    await alerts.run();
    const entries = await prisma.usageLedgerEntry.count({ where: { workspaceId, kind: 'ALERT', dedupeKey: { startsWith: 'alert:apiRequests' } } });
    expect(entries).toBeGreaterThan(0);
    expect(webhooks.emit.mock.calls.filter((c: any[]) => c[1] === 'usage.threshold' && c[2]?.metric === 'apiRequests' && c[2]?.threshold === 100)).toHaveLength(1);
  });

  it('una invitación al equipo se guarda con su índice único', async () => {
    const owner = await prisma.workspace.findUnique({ where: { id: workspaceId } });
    const data = { workspaceId, email: 'nuevo@e2e.test', role: 'EDITOR', tokenHash: `h1-${stamp}`, invitedById: owner.ownerId, expiresAt: new Date(Date.now() + 1e9) };
    await prisma.workspaceInvitation.create({ data });
    await expect(prisma.workspaceInvitation.create({ data: { ...data, tokenHash: `h2-${stamp}` } })).rejects.toThrow();
  });
});
