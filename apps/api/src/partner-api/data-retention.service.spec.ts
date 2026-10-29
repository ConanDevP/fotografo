import { DataRetentionService, retentionCutoff } from './data-retention.service';

describe('retentionCutoff', () => {
  it('resta los días de retención', () => {
    const cutoff = retentionCutoff(30, new Date('2026-10-28T00:00:00Z'));
    expect(cutoff.toISOString()).toBe('2026-09-28T00:00:00.000Z');
  });
});

describe('DataRetentionService.run', () => {
  const NOW = new Date('2026-10-28T12:00:00Z');
  function build(salesByEvent: Record<string, number>) {
    const prisma: any = {
      enterpriseAccount: {
        findMany: jest.fn().mockResolvedValue([
          { workspaceId: 'ws', retentionDays: 30, technicalContactEmail: null, businessContactEmail: null, workspace: { name: 'Cliente' } },
        ]),
      },
      event: { findMany: jest.fn().mockResolvedValue([{ id: 'e1', name: 'Maratón A' }, { id: 'e2', name: 'Maratón B' }]) },
      order: { count: jest.fn(async ({ where }: any) => salesByEvent[where.eventId] ?? 0) },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
      usageLedgerEntry: { createMany: jest.fn() },
    };
    const events: any = { purgeForRetention: jest.fn().mockResolvedValue({ deletedObjects: 3 }) };
    return { prisma, events, service: new DataRetentionService(prisma, events) };
  }

  afterEach(() => { delete process.env.RETENTION_ENFORCE; });

  it('por defecto solo simula y deja constancia, sin borrar nada', async () => {
    const { service, events, prisma } = build({});
    const result = await service.run(NOW);
    expect(result).toMatchObject({ purged: 0, simulated: 2 });
    expect(events.purgeForRetention).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'RETENTION_DRY_RUN' }) }));
  });

  it('con RETENTION_ENFORCE=true borra los eventos vencidos', async () => {
    process.env.RETENTION_ENFORCE = 'true';
    const { service, events } = build({});
    const result = await service.run(NOW);
    expect(result.purged).toBe(2);
    expect(events.purgeForRetention).toHaveBeenCalledTimes(2);
  });

  it('nunca borra un evento con compras', async () => {
    process.env.RETENTION_ENFORCE = 'true';
    const { service, events } = build({ e1: 4 });
    const result = await service.run(NOW);
    expect(result).toMatchObject({ purged: 1, skippedWithSales: 1 });
    expect(events.purgeForRetention).toHaveBeenCalledWith('e2');
    expect(events.purgeForRetention).not.toHaveBeenCalledWith('e1');
  });
});
