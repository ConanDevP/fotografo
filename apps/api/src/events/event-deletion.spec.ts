import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';

import { EventsService } from './events.service';
import { PrismaService } from '../common/services/prisma.service';
import { StorageService } from '../common/services/storage.service';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { QueueService } from '../common/services/queue.service';
import { BillingService } from '../billing/billing.service';
import { UserRole } from '@shared/types';

/**
 * Borrar un evento destruye ficheros que no se recuperan. Estas pruebas fijan
 * las tres cosas que no pueden fallar: que no se lleve por delante lo que
 * alguien ya compró, que devuelva el espacio a quien corresponde, y que limpie
 * el almacenamiento en lugar de dejarlo pagándose.
 */
describe('Borrado de un evento', () => {
  let service: EventsService;
  let prisma: any;
  let storage: any;
  let billing: any;

  const EVENT = 'ev-1';

  beforeEach(async () => {
    prisma = {
      order: { count: jest.fn().mockResolvedValue(0) },
      photo: { groupBy: jest.fn().mockResolvedValue([]), deleteMany: jest.fn() },
      event: { delete: jest.fn() },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
      $transaction: jest.fn().mockImplementation(async (fn: any) => fn(prisma)),
    };

    storage = { deleteEventObjects: jest.fn().mockResolvedValue({ deleted: 12, failed: 0 }) };
    billing = { releaseStorage: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EventsService,
        { provide: PrismaService, useValue: prisma },
        { provide: StorageService, useValue: storage },
        { provide: WorkspacesService, useValue: {} },
        { provide: QueueService, useValue: {} },
        { provide: BillingService, useValue: billing },
      ],
    }).compile();

    service = module.get<EventsService>(EventsService);
    jest.spyOn(service as any, 'findOne').mockResolvedValue({ id: EVENT, name: 'Media maratón' });
    jest.spyOn(service as any, 'assertCanManageEvent').mockResolvedValue(undefined);
  });

  it('no borra un evento del que alguien ya compró fotografías', async () => {
    // `order_items` apunta a `photos` con ON DELETE SET NULL: el pedido
    // sobreviviría sin nada que descargar y quien pagó se quedaría sin lo suyo.
    prisma.order.count.mockResolvedValue(3);

    await expect(service.remove(EVENT, 'user-1', UserRole.PHOTOGRAPHER)).rejects.toThrow(
      BadRequestException,
    );
    expect(prisma.photo.deleteMany).not.toHaveBeenCalled();
    expect(storage.deleteEventObjects).not.toHaveBeenCalled();
  });

  it('borra las fotografías antes que el evento', async () => {
    // La clave ajena de `photos` hacia `events` es RESTRICT: al revés falla.
    const orden: string[] = [];
    prisma.photo.deleteMany.mockImplementation(async () => { orden.push('fotos'); });
    prisma.event.delete.mockImplementation(async () => { orden.push('evento'); });

    await service.remove(EVENT, 'user-1', UserRole.PHOTOGRAPHER);

    expect(orden).toEqual(['fotos', 'evento']);
  });

  it('devuelve el espacio a cada espacio de trabajo que aportó fotografías', async () => {
    prisma.photo.groupBy.mockResolvedValue([
      { photographerWorkspaceId: 'ws-1', _sum: { originalBytes: 1000, derivedBytes: 200 } },
      { photographerWorkspaceId: 'ws-2', _sum: { originalBytes: 500, derivedBytes: 50 } },
    ]);

    await service.remove(EVENT, 'user-1', UserRole.PHOTOGRAPHER);

    expect(billing.releaseStorage).toHaveBeenCalledWith('ws-1', 1200, prisma);
    expect(billing.releaseStorage).toHaveBeenCalledWith('ws-2', 550, prisma);
  });

  it('cuenta como cero los tamaños que nunca se registraron', async () => {
    // `originalBytes` es opcional; sumar null daría NaN y dejaría el medidor
    // en un estado del que no se sale sin tocar la base a mano.
    prisma.photo.groupBy.mockResolvedValue([
      { photographerWorkspaceId: 'ws-1', _sum: { originalBytes: null, derivedBytes: null } },
    ]);

    await service.remove(EVENT, 'user-1', UserRole.PHOTOGRAPHER);

    expect(billing.releaseStorage).toHaveBeenCalledWith('ws-1', 0, prisma);
  });

  it('limpia el almacenamiento del evento', async () => {
    const result = await service.remove(EVENT, 'user-1', UserRole.PHOTOGRAPHER);

    expect(storage.deleteEventObjects).toHaveBeenCalledWith(EVENT);
    expect(result.deletedObjects).toBe(12);
  });

  it('deja constancia si el almacenamiento no se pudo limpiar del todo', async () => {
    // La base ya está borrada: fallar aquí devolvería un error por algo que ya
    // está hecho. Se anota para repasarlo y el fotógrafo sigue su camino.
    storage.deleteEventObjects.mockResolvedValue({ deleted: 8, failed: 4 });

    await expect(service.remove(EVENT, 'user-1', UserRole.PHOTOGRAPHER)).resolves.toBeDefined();
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'EVENT_STORAGE_CLEANUP_REQUIRED' }),
      }),
    );
  });
});
