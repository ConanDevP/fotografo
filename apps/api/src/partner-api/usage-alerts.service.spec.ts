import { crossedThresholds, UsageAlertsService } from './usage-alerts.service';

describe('crossedThresholds', () => {
  it('no avisa por debajo del 80 %', () => {
    expect(crossedThresholds(79, 100, new Set())).toEqual([]);
  });
  it('avisa del 80 % al alcanzarlo', () => {
    expect(crossedThresholds(80, 100, new Set())).toEqual([80]);
  });
  it('avisa de ambos si se salta directamente al 100 %', () => {
    expect(crossedThresholds(100, 100, new Set())).toEqual([80, 100]);
  });
  it('no repite un umbral ya avisado', () => {
    expect(crossedThresholds(95, 100, new Set([80]))).toEqual([]);
    expect(crossedThresholds(100, 100, new Set([80]))).toEqual([100]);
  });
  it('sin tope no hay aviso', () => {
    expect(crossedThresholds(1_000_000, null, new Set())).toEqual([]);
    expect(crossedThresholds(5, 0, new Set())).toEqual([]);
  });
});

describe('UsageAlertsService.checkWorkspace', () => {
  function build(used: number, existingKeys: string[] = [], createdCount = 1) {
    const prisma: any = {
      enterpriseAccount: {
        findUnique: jest.fn().mockResolvedValue({
          annualPhotoLimit: 1000, monthlyApiRequestLimit: null, monthlyFaceSearchLimit: null, status: 'ACTIVE',
          contractStart: new Date('2026-01-01T00:00:00Z'), contractEnd: null, allowOverage: false,
          technicalContactEmail: 'dev@cliente.com', businessContactEmail: null, billingContactEmail: null,
          workspace: { name: 'Cliente' },
        }),
      },
      partnerApiUsage: { findUnique: jest.fn().mockResolvedValue(null) },
      usageLedgerEntry: {
        aggregate: jest.fn().mockResolvedValue({ _sum: { quantity: used } }),
        findMany: jest.fn().mockResolvedValue(existingKeys.map(dedupeKey => ({ dedupeKey }))),
        createMany: jest.fn().mockResolvedValue({ count: createdCount }),
      },
    };
    const webhooks: any = { emit: jest.fn().mockResolvedValue(undefined) };
    const mailer: any = { isConfigured: true, send: jest.fn().mockResolvedValue(true) };
    return { prisma, webhooks, mailer, service: new UsageAlertsService(prisma, webhooks, mailer) };
  }

  const NOW = new Date('2026-10-28T12:00:00Z');

  it('al cruzar el 80 % emite el webhook y envía el correo', async () => {
    const { service, webhooks, mailer } = build(800);
    expect(await service.checkWorkspace('ws', NOW)).toBe(1);
    expect(webhooks.emit).toHaveBeenCalledWith('ws', 'usage.threshold', expect.objectContaining({ metric: 'photos', threshold: 80, used: 800, limit: 1000 }));
    expect(mailer.send).toHaveBeenCalledWith(expect.objectContaining({ to: 'dev@cliente.com' }));
  });

  it('no avisa si el umbral ya constaba en el libro', async () => {
    const { service, webhooks } = build(850, ['alert:photos:80:ws:2026-01-01']);
    expect(await service.checkWorkspace('ws', NOW)).toBe(0);
    expect(webhooks.emit).not.toHaveBeenCalled();
  });

  it('si otra ejecución ganó la inserción (count 0), no avisa dos veces', async () => {
    const { service, webhooks } = build(850, [], 0);
    expect(await service.checkWorkspace('ws', NOW)).toBe(0);
    expect(webhooks.emit).not.toHaveBeenCalled();
  });
});
