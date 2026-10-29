import { NotFoundException } from '@nestjs/common';
import { MetricsService } from './metrics.service';

function build(event: any, photo: any = null) {
  const prisma: any = {
    event: { findUnique: jest.fn().mockResolvedValue(event) },
    photo: { findUnique: jest.fn().mockResolvedValue(photo) },
    workspace: { findUnique: jest.fn() },
    workspaceMember: { findFirst: jest.fn() },
    metricEvent: { create: jest.fn().mockResolvedValue({}) },
  };
  const service = new MetricsService(prisma, { get: () => 'secreto-de-prueba' } as any, {} as any, {} as any);
  const req: any = { ip: '203.0.113.7', socket: {}, headers: { 'user-agent': 'Mozilla/5.0 (iPhone)' } };
  return { prisma, service, req };
}

describe('MetricsService.record con espacio de confianza (Partner API)', () => {
  it('acepta un evento sin publicar si es del espacio de la credencial', async () => {
    const { service, prisma, req } = build({ workspaceId: 'ws-1' });
    await service.record({ type: 'EVENT_VIEW', eventId: 'ev-1' } as any, req, undefined, { trustedWorkspaceId: 'ws-1' });
    expect(prisma.event.findUnique.mock.calls[0][0].where).not.toHaveProperty('isPublished');
    expect(prisma.metricEvent.create).toHaveBeenCalled();
  });

  it('rechaza un evento de otro espacio como si no existiera', async () => {
    const { service, prisma, req } = build({ workspaceId: 'ws-2' });
    await expect(service.record({ type: 'EVENT_VIEW', eventId: 'ev-1' } as any, req, undefined, { trustedWorkspaceId: 'ws-1' })).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.metricEvent.create).not.toHaveBeenCalled();
  });

  it('una fotografía sin aprobar del propio espacio sí cuenta, una de otro no', async () => {
    const own = build({ workspaceId: 'ws-1' }, { eventId: 'ev-1', status: 'PENDING', publicationStatus: 'PENDING_REVIEW', event: { workspaceId: 'ws-1', isPublished: false, deletedAt: null } });
    await own.service.record({ type: 'PHOTO_VIEW', eventId: 'ev-1', photoId: 'p1' } as any, own.req, undefined, { trustedWorkspaceId: 'ws-1' });
    expect(own.prisma.metricEvent.create).toHaveBeenCalled();

    const foreign = build({ workspaceId: 'ws-1' }, { eventId: 'ev-1', status: 'PROCESSED', publicationStatus: 'APPROVED', event: { workspaceId: 'ws-2', isPublished: true, deletedAt: null } });
    await expect(foreign.service.record({ type: 'PHOTO_VIEW', eventId: 'ev-1', photoId: 'p1' } as any, foreign.req, undefined, { trustedWorkspaceId: 'ws-1' })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('sin espacio de confianza (tienda pública) sigue exigiendo evento publicado', async () => {
    const { service, prisma, req } = build({ workspaceId: 'ws-1' });
    await service.record({ type: 'EVENT_VIEW', eventId: 'ev-1' } as any, req);
    expect(prisma.event.findUnique.mock.calls[0][0].where).toMatchObject({ isPublished: true });
  });
});
