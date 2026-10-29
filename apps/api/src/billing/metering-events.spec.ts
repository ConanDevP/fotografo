import { ForbiddenException } from '@nestjs/common';
import { MeteringService } from './metering.service';

function build(account: any, created: number) {
  const prisma: any = {
    enterpriseAccount: { findUnique: jest.fn().mockResolvedValue(account) },
    $queryRaw: jest.fn().mockResolvedValue([{ total: BigInt(created) }]),
  };
  return { prisma, service: new MeteringService(prisma) };
}

const PILOT = { status: 'PILOT', contractStart: null, contractEnd: null, annualEventLimit: 3 };

describe('límite anual de eventos', () => {
  it('no limita a un espacio sin contrato', async () => {
    const { service, prisma } = build(null, 99);
    await expect(service.assertEventCapacity('ws')).resolves.toBeUndefined();
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('no limita si el contrato no fija tope', async () => {
    const { service } = build({ ...PILOT, annualEventLimit: null }, 99);
    await expect(service.assertEventCapacity('ws')).resolves.toBeUndefined();
  });

  it('permite crear el último evento del cupo', async () => {
    const { service } = build(PILOT, 2);
    await expect(service.assertEventCapacity('ws')).resolves.toBeUndefined();
  });

  it('rechaza el evento que supera el cupo e indica el código', async () => {
    const { service } = build(PILOT, 3);
    await expect(service.assertEventCapacity('ws')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'EVENT_LIMIT_REACHED', limit: 3, used: 3 }),
    });
    await expect(service.assertEventCapacity('ws')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('no aplica el tope si el contrato está suspendido', async () => {
    const { service } = build({ ...PILOT, status: 'SUSPENDED' }, 50);
    await expect(service.assertEventCapacity('ws')).resolves.toBeUndefined();
  });
});

describe('a quién se imputa una foto', () => {
  function withEvent(eventWorkspace: string | null, account: any) {
    const prisma: any = {
      event: { findUnique: jest.fn().mockResolvedValue({ workspaceId: eventWorkspace }) },
      enterpriseAccount: { findUnique: jest.fn().mockResolvedValue(account) },
    };
    return new MeteringService(prisma);
  }

  it('al organizador con contrato vigente, suba quien suba', async () => {
    const service = withEvent('org', { status: 'ACTIVE', contractStart: null, contractEnd: null });
    await expect(service.meteredWorkspace('ev', 'fotografo')).resolves.toBe('org');
  });

  it('al fotógrafo si el organizador no tiene contrato', async () => {
    const service = withEvent('org', null);
    await expect(service.meteredWorkspace('ev', 'fotografo')).resolves.toBe('fotografo');
  });

  it('al fotógrafo si el contrato está suspendido o vencido', async () => {
    const suspended = withEvent('org', { status: 'SUSPENDED', contractStart: null, contractEnd: null });
    await expect(suspended.meteredWorkspace('ev', 'fotografo')).resolves.toBe('fotografo');
    const ended = withEvent('org', { status: 'ACTIVE', contractStart: null, contractEnd: new Date(Date.now() - 1000) });
    await expect(ended.meteredWorkspace('ev', 'fotografo')).resolves.toBe('fotografo');
  });

  it('sin cambios cuando sube el propio organizador', async () => {
    const service = withEvent('org', { status: 'ACTIVE', contractStart: null, contractEnd: null });
    await expect(service.meteredWorkspace('ev', 'org')).resolves.toBe('org');
  });
});
