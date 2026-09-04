import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createHash } from 'crypto';
import { PartnerApiKeyGuard } from './partner-api-key.guard';

const PREFIX = '0123456789abcdef';
const KEY = `lm_live_${PREFIX}_${'a'.repeat(43)}`;

function context(request: any, required: string[] = []) {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
    required,
  } as any;
}

describe('PartnerApiKeyGuard', () => {
  const client = {
    id: 'client-1',
    workspaceId: 'workspace-1',
    createdById: 'user-1',
    keyPrefix: PREFIX,
    secretHash: createHash('sha256').update(KEY).digest('hex'),
    scopes: ['events:read'],
    expiresAt: null,
    revokedAt: null,
    lastUsedAt: new Date(),
    workspace: { id: 'workspace-1', ownerId: 'user-1', deletedAt: null },
  };

  function setup(required: string[] = []) {
    const prisma = {
      apiClient: {
        findUnique: jest.fn().mockResolvedValue(client),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      user: { findFirst: jest.fn().mockResolvedValue({ id: 'user-1', role: 'PHOTOGRAPHER' }) },
      workspaceMember: { findFirst: jest.fn() },
    };
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue(required) } as unknown as Reflector;
    return { guard: new PartnerApiKeyGuard(prisma as any, reflector), prisma };
  }

  it('autentica una clave válida y añade el contexto de workspace', async () => {
    const { guard } = setup(['events:read']);
    const request = { headers: { authorization: `Bearer ${KEY}` } };
    await expect(guard.canActivate(context(request))).resolves.toBe(true);
    expect(request).toHaveProperty('partner.workspaceId', 'workspace-1');
    expect(request).toHaveProperty('partner.apiClientId', 'client-1');
  });

  it('rechaza una clave con secreto incorrecto', async () => {
    const { guard } = setup();
    const wrong = `lm_live_${PREFIX}_${'b'.repeat(43)}`;
    await expect(guard.canActivate(context({ headers: { authorization: `Bearer ${wrong}` } })))
      .rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rechaza una credencial revocada', async () => {
    const { guard, prisma } = setup();
    prisma.apiClient.findUnique.mockResolvedValueOnce({ ...client, revokedAt: new Date() });
    await expect(guard.canActivate(context({ headers: { authorization: `Bearer ${KEY}` } })))
      .rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rechaza scopes ausentes', async () => {
    const { guard } = setup(['photos:upload']);
    await expect(guard.canActivate(context({ headers: { authorization: `Bearer ${KEY}` } })))
      .rejects.toBeInstanceOf(ForbiddenException);
  });

  it('invalida la clave si su creador fue degradado a un rol sin administración', async () => {
    const { guard, prisma } = setup();
    prisma.apiClient.findUnique.mockResolvedValueOnce({
      ...client,
      workspace: { ...client.workspace, ownerId: 'another-owner' },
    });
    prisma.workspaceMember.findFirst.mockResolvedValueOnce(null);
    await expect(guard.canActivate(context({ headers: { authorization: `Bearer ${KEY}` } })))
      .rejects.toBeInstanceOf(UnauthorizedException);
  });
});
