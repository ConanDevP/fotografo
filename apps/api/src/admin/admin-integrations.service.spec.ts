import { AdminIntegrationsService } from './admin-integrations.service';

describe('AdminIntegrationsService', () => {
  it('revoca y registra al administrador sin exponer el secreto', async () => {
    const client = {
      id: 'client-1', workspaceId: 'workspace-1', name: 'Cronometraje',
      keyPrefix: '0123456789abcdef', revokedAt: null,
    };
    const prisma = {
      apiClient: {
        findUnique: jest.fn().mockResolvedValue(client),
        update: jest.fn().mockReturnValue({ operation: 'update' }),
      },
      auditLog: { create: jest.fn().mockReturnValue({ operation: 'audit' }) },
      $transaction: jest.fn().mockResolvedValue([]),
    };
    const service = new AdminIntegrationsService(prisma as any);
    const result = await service.revoke('client-1', 'admin-1', 'Cliente solicitó bloqueo');

    expect(result.revoked).toBe(true);
    expect(prisma.apiClient.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'client-1' }, data: { revokedAt: expect.any(Date) },
    }));
    expect(prisma.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      userId: 'admin-1', action: 'API_CLIENT_REVOKED_BY_ADMIN',
    }) });
    expect(JSON.stringify(prisma.auditLog.create.mock.calls)).not.toContain('secretHash');
  });

  it('es idempotente si ya estaba revocada', async () => {
    const revokedAt = new Date();
    const prisma = {
      apiClient: { findUnique: jest.fn().mockResolvedValue({ id: 'client-1', revokedAt }) },
      $transaction: jest.fn(),
    };
    const service = new AdminIntegrationsService(prisma as any);
    await expect(service.revoke('client-1', 'admin-1')).resolves.toEqual({
      revoked: true, alreadyRevoked: true, revokedAt,
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
