jest.mock('dns/promises', () => ({ lookup: jest.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]) }));
import { BadRequestException } from '@nestjs/common';
import { PartnerWebhooksService } from './partner-webhooks.service';

describe('PartnerWebhooksService', () => {
  const principal: any = { workspaceId: 'ws-1', apiClientId: 'client-1' };

  function setup() {
    const prisma: any = {
      partnerWebhookEndpoint: {
        create: jest.fn().mockImplementation(({ data }: any) => ({ id: 'ep-1', url: data.url, events: data.events, active: true, createdAt: new Date() })),
        findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn(), update: jest.fn(), delete: jest.fn(),
      },
      partnerWebhookDelivery: { createMany: jest.fn(), findMany: jest.fn(), findFirst: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    };
    const config: any = { get: jest.fn().mockReturnValue('a'.repeat(64)) };
    return { service: new PartnerWebhooksService(prisma, config), prisma };
  }

  it('crea un secreto de firma que solo se devuelve al crearlo', async () => {
    const { service, prisma } = setup();
    const result = await service.create(principal, { url: 'https://hooks.example.com/lucilamon', events: ['event.created'] });
    expect(result.signingSecret).toMatch(/^whsec_/);
    expect(prisma.partnerWebhookEndpoint.create.mock.calls[0][0].data.secretEncrypted).not.toContain(result.signingSecret);
  });

  it('rechaza destinos privados para impedir SSRF', async () => {
    const { lookup } = jest.requireMock('dns/promises');
    lookup.mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }]);
    const { service } = setup();
    await expect(service.create(principal, { url: 'https://internal.example.com/hook', events: ['event.created'] }))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('crea una entrega por endpoint suscrito con un mismo event id', async () => {
    const { service, prisma } = setup();
    prisma.partnerWebhookEndpoint.findMany.mockResolvedValue([{ id: 'ep-1' }, { id: 'ep-2' }]);
    await service.emit('ws-1', 'photo.processing.completed', { photoId: 'photo-1' });
    const rows = prisma.partnerWebhookDelivery.createMany.mock.calls[0][0].data;
    expect(rows).toHaveLength(2);
    expect(rows[0].eventId).toBe(rows[1].eventId);
  });
});
