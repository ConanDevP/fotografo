import { PROCESSING_PRIORITY, ProcessingPriorityService } from './processing-priority.service';

function build(account: any) {
  const prisma: any = { enterpriseAccount: { findUnique: jest.fn().mockResolvedValue(account) } };
  return { prisma, service: new ProcessingPriorityService(prisma) };
}

const NOW = new Date('2026-10-28T12:00:00Z').getTime();
const ACTIVE = { status: 'ACTIVE', priorityProcessingEnabled: true, contractStart: new Date('2026-01-01'), contractEnd: new Date('2027-01-01') };

describe('ProcessingPriorityService', () => {
  it('un espacio sin contrato usa la prioridad normal', async () => {
    expect(await build(null).service.forWorkspace('ws', NOW)).toBe(PROCESSING_PRIORITY.NORMAL);
  });

  it('un contrato con procesamiento prioritario pasa por delante', async () => {
    expect(await build(ACTIVE).service.forWorkspace('ws', NOW)).toBe(PROCESSING_PRIORITY.PRIORITY);
    expect(PROCESSING_PRIORITY.PRIORITY).toBeLessThan(PROCESSING_PRIORITY.NORMAL);
  });

  it('sin la opción contratada no hay prioridad', async () => {
    expect(await build({ ...ACTIVE, priorityProcessingEnabled: false }).service.forWorkspace('ws', NOW)).toBe(PROCESSING_PRIORITY.NORMAL);
  });

  it('un contrato vencido pierde la prioridad', async () => {
    expect(await build({ ...ACTIVE, contractEnd: new Date('2026-02-01') }).service.forWorkspace('ws', NOW)).toBe(PROCESSING_PRIORITY.NORMAL);
  });

  it('no consulta la base en cada foto: usa caché', async () => {
    const { service, prisma } = build(ACTIVE);
    await service.forWorkspace('ws', NOW);
    await service.forWorkspace('ws', NOW + 1000);
    expect(prisma.enterpriseAccount.findUnique).toHaveBeenCalledTimes(1);
    await service.forWorkspace('ws', NOW + 61_000);
    expect(prisma.enterpriseAccount.findUnique).toHaveBeenCalledTimes(2);
  });

  it('sin espacio, prioridad normal', async () => {
    expect(await build(ACTIVE).service.forWorkspace(null, NOW)).toBe(PROCESSING_PRIORITY.NORMAL);
  });
});
