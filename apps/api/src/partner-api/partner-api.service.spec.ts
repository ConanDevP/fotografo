import { NotFoundException } from '@nestjs/common';
jest.mock('../events/events.service', () => ({ EventsService: class EventsService {} }));
jest.mock('../uploads/uploads.service', () => ({ UploadsService: class UploadsService {} }));
jest.mock('../photos/photos.service', () => ({ PhotosService: class PhotosService {} }));
jest.mock('../search/search.service', () => ({ SearchService: class SearchService {} }));
jest.mock('../search/face-search.service', () => ({ FaceSearchService: class FaceSearchService {} }));
jest.mock('../workspaces/workspaces.service', () => ({ WorkspacesService: class WorkspacesService {} }));
jest.mock('../sponsors/sponsors.service', () => ({ SponsorsService: class SponsorsService {} }));
jest.mock('../events/free-downloads.service', () => ({ FreeDownloadsService: class FreeDownloadsService {} }));
import { PartnerApiService } from './partner-api.service';

describe('PartnerApiService isolation', () => {
  const principal = {
    apiClientId: 'client-1',
    workspaceId: 'workspace-1',
    actorUserId: 'user-1',
    actorRole: 'PHOTOGRAPHER',
    keyPrefix: 'prefix',
    scopes: ['events:read', 'photos:read'] as any,
  };

  it('no permite consultar un evento de otro workspace', async () => {
    const prisma = {
      event: { findFirst: jest.fn().mockResolvedValue(null) },
      batchUploadJob: { findFirst: jest.fn() },
    };
    const events = { findOneForUser: jest.fn() };
    const service = new PartnerApiService(prisma as any, events as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);

    await expect(service.getEvent(principal, 'event-foreign')).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.event.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'event-foreign', workspaceId: 'workspace-1' }),
    }));
    expect(events.findOneForUser).not.toHaveBeenCalled();
  });

  it('no permite consultar un lote cuyo evento pertenece a otro workspace', async () => {
    const prisma = {
      event: { findFirst: jest.fn() },
      batchUploadJob: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const uploads = { getBatchUploadStatusDetailed: jest.fn() };
    const service = new PartnerApiService(prisma as any, {} as any, uploads as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);

    await expect(service.getBatch(principal, 'batch-foreign')).rejects.toBeInstanceOf(NotFoundException);
    expect(uploads.getBatchUploadStatusDetailed).not.toHaveBeenCalled();
  });

  it('no permite descargar una fotografía de otro workspace', async () => {
    const prisma = { photo: { findFirst: jest.fn().mockResolvedValue(null) } };
    const photos = { generateSecureDownloadUrl: jest.fn() };
    const service = new PartnerApiService(prisma as any, {} as any, {} as any, photos as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);

    await expect(service.downloadPhoto(principal, 'photo-foreign', 300)).rejects.toBeInstanceOf(NotFoundException);
    expect(photos.generateSecureDownloadUrl).not.toHaveBeenCalled();
  });

  it('permite buscar un dorsal privado solo después de validar el workspace', async () => {
    const prisma = { event: { findFirst: jest.fn().mockResolvedValue({ id: 'event-1' }) } };
    const search = { searchPhotosByBib: jest.fn().mockResolvedValue({ items: [], total: 0 }) };
    const service = new PartnerApiService(prisma as any, {} as any, {} as any, {} as any, search as any, {} as any, {} as any, {} as any, {} as any, {} as any);

    await service.searchByBib(principal, 'event-1', '123', 25);
    expect(search.searchPhotosByBib).toHaveBeenCalledWith('event-1', '123', 25, undefined, true);
  });

  it('el detalle empresarial no selecciona el original ni la clave de almacenamiento', async () => {
    const prisma = {
      photo: {
        findFirst: jest.fn().mockResolvedValue({ id: 'photo-1' }),
        findUnique: jest.fn().mockResolvedValue({ id: 'photo-1', bibs: [], faces: [] }),
      },
    };
    const service = new PartnerApiService(prisma as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);

    const result = await service.getPhoto(principal, 'photo-1');
    const select = prisma.photo.findUnique.mock.calls[0][0].select;
    expect(select.originalUrl).toBeUndefined();
    expect(select.cloudinaryId).toBeUndefined();
    expect(result).not.toHaveProperty('originalUrl');
  });

  it('expone las tres variantes derivadas sin el original', async () => {
    const prisma = {
      photo: {
        findFirst: jest.fn().mockResolvedValue({ id: 'photo-1' }),
        findUnique: jest.fn().mockResolvedValue({
          id: 'photo-1', eventId: 'event-1', status: 'PROCESSED', width: 2000, height: 1300,
          thumbUrl: 'thumb', watermarkUrl: 'watermark', watermarkThumbUrl: 'watermark-thumb',
          derivativesProcessedAt: new Date(), watermarkFailedAt: null,
        }),
      },
    };
    const service = new PartnerApiService(prisma as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);

    const result = await service.getPhotoAssets(principal, 'photo-1');
    expect(result.assets).toEqual({ thumbnail: 'thumb', watermark: 'watermark', watermarkThumbnail: 'watermark-thumb' });
    expect(result).not.toHaveProperty('originalUrl');
  });

  it('reutiliza el flujo real de descarga gratuita patrocinada', async () => {
    const prisma = {
      event: { findFirst: jest.fn().mockResolvedValue({ id: 'event-1' }) },
      photo: { findFirst: jest.fn().mockResolvedValue({ id: 'photo-1' }) },
    };
    const webhooks = { emit: jest.fn().mockResolvedValue(undefined) };
    const freeDownloads = { downloadFreePhoto: jest.fn().mockResolvedValue({ downloadUrl: 'signed', expiresIn: 900, variant: 'SPONSORED', sponsors: [{ id: 's1' }] }) };
    const service = new PartnerApiService(prisma as any, {} as any, {} as any, {} as any, {} as any, {} as any, webhooks as any, {} as any, {} as any, freeDownloads as any);

    const result = await service.freeDownloadPhoto(principal, 'event-1', 'photo-1', { email: 'runner@example.com' }, {} as any);
    expect(result.variant).toBe('SPONSORED');
    expect(freeDownloads.downloadFreePhoto).toHaveBeenCalledWith('event-1', 'photo-1', { email: 'runner@example.com' }, expect.anything());
    expect(webhooks.emit).toHaveBeenCalledWith('workspace-1', 'photo.free_downloaded', expect.objectContaining({ variant: 'SPONSORED' }));
  });

  it('solo restaura eventos archivados del workspace de la credencial', async () => {
    const prisma = { event: { findFirst: jest.fn().mockResolvedValue(null), update: jest.fn() } };
    const service = new PartnerApiService(prisma as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
    await expect(service.restoreEvent(principal, 'event-foreign')).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.event.update).not.toHaveBeenCalled();
  });
});
