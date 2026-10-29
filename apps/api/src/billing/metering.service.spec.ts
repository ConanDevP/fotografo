import { ForbiddenException } from '@nestjs/common';
import { MeteringService } from './metering.service';

function build(account: any, used: number) {
  const prisma: any = {
    enterpriseAccount: { findUnique: jest.fn().mockResolvedValue(account) },
    usageLedgerEntry: {
      aggregate: jest.fn().mockResolvedValue({ _sum: { quantity: used } }),
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  return { prisma, service: new MeteringService(prisma) };
}

const ACTIVE = { status: 'ACTIVE', contractStart: new Date('2026-01-01T00:00:00Z'), contractEnd: new Date('2027-01-01T00:00:00Z'), annualPhotoLimit: 1000 };

describe('MeteringService', () => {
  it('no limita a un espacio sin contrato Enterprise', async () => {
    const { service } = build(null, 999_999);
    await expect(service.assertPhotoCapacity('ws', 5000)).resolves.toBeUndefined();
  });

  it('no limita si el contrato no tiene tope de fotografías', async () => {
    const { service } = build({ ...ACTIVE, annualPhotoLimit: null }, 999_999);
    await expect(service.assertPhotoCapacity('ws', 5000)).resolves.toBeUndefined();
  });

  it('permite una subida que cabe exactamente en el cupo', async () => {
    const { service } = build(ACTIVE, 900);
    await expect(service.assertPhotoCapacity('ws', 100)).resolves.toBeUndefined();
  });

  it('rechaza una subida que supera el cupo y explica cuánto queda', async () => {
    const { service } = build(ACTIVE, 900);
    await expect(service.assertPhotoCapacity('ws', 101)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'PHOTO_LIMIT_REACHED', limit: 1000, used: 900, requested: 101 }),
    });
    await expect(service.assertPhotoCapacity('ws', 101)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('un contrato vencido deja de aplicar el tope', async () => {
    const { service } = build({ ...ACTIVE, contractEnd: new Date('2026-02-01T00:00:00Z') }, 999_999);
    await expect(service.assertPhotoCapacity('ws', 5000)).resolves.toBeUndefined();
  });

  it('anota el crédito con clave de deduplicación por foto', async () => {
    const { service, prisma } = build(ACTIVE, 0);
    await service.recordPhoto('ws', 'photo-1', 'event-1');
    expect(prisma.usageLedgerEntry.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        skipDuplicates: true,
        data: [expect.objectContaining({ dedupeKey: 'photo:photo-1', workspaceId: 'ws', quantity: 1 })],
      }),
    );
  });

  it('un fallo al anotar nunca tumba la subida', async () => {
    const { service, prisma } = build(ACTIVE, 0);
    prisma.usageLedgerEntry.createMany.mockRejectedValue(new Error('db caída'));
    await expect(service.recordPhoto('ws', 'photo-1')).resolves.toBeUndefined();
  });

  it('ignora fotos sin espacio', async () => {
    const { service, prisma } = build(ACTIVE, 0);
    await service.recordPhoto(null, 'photo-1');
    expect(prisma.usageLedgerEntry.createMany).not.toHaveBeenCalled();
  });
});
