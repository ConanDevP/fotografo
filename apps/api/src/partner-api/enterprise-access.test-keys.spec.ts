import { ForbiddenException } from '@nestjs/common';
import { EnterpriseAccessService } from './enterprise-access.service';

function build(account: any) {
  const prisma: any = {
    enterpriseAccount: { findUnique: jest.fn().mockResolvedValue(account) },
    $queryRaw: jest.fn().mockResolvedValue([{ request_count: 1n, face_search_count: 0n }]),
  };
  return new EnterpriseAccessService(prisma, { get: jest.fn() } as any);
}

const PILOT = { status: 'PILOT', partnerApiEnabled: true, contractStart: null, contractEnd: null, monthlyApiRequestLimit: null, monthlyFaceSearchLimit: null };

describe('claves de prueba y contrato', () => {
  it('una clave de prueba funciona durante el piloto', async () => {
    await expect(build(PILOT).authorizeExistingClient('ws', ['events:read'], ['events:read'], 'TEST')).resolves.toBeUndefined();
  });

  it('una clave de prueba deja de valer cuando el contrato pasa a ACTIVE', async () => {
    const service = build({ ...PILOT, status: 'ACTIVE' });
    await expect(service.authorizeExistingClient('ws', ['events:read'], ['events:read'], 'TEST')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('una clave de producción sigue valiendo con el contrato activo', async () => {
    const service = build({ ...PILOT, status: 'ACTIVE' });
    await expect(service.authorizeExistingClient('ws', ['events:read'], ['events:read'], 'LIVE')).resolves.toBeUndefined();
  });

  it('registra el uso aunque el contrato no tenga tope de peticiones', async () => {
    const prisma: any = {
      enterpriseAccount: { findUnique: jest.fn().mockResolvedValue(PILOT) },
      $queryRaw: jest.fn().mockResolvedValue([{ request_count: 1n, face_search_count: 0n }]),
    };
    const service = new EnterpriseAccessService(prisma, { get: jest.fn() } as any);
    await service.authorizeExistingClient('ws', ['events:read'], ['events:read'], 'TEST');
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });
});
