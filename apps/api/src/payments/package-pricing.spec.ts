import { Test } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';

import { PaymentsService } from './payments.service';
import { PrismaService } from '../common/services/prisma.service';

/**
 * El precio de "todas las fotografías" es el mayor descuento del catálogo.
 * Sin comprobar que el lote esté completo, cualquiera compra fotografías
 * sueltas a ese precio llamando a la API directamente.
 */
describe('Paquete de todas las fotografías', () => {
  let service: PaymentsService;
  let prisma: any;

  const build = async () => {
    prisma = {
      photo: { count: jest.fn() },
      photoBib: { findMany: jest.fn() },
    };
    const module = await Test.createTestingModule({
      providers: [PaymentsService, { provide: PrismaService, useValue: prisma }],
    })
      .overrideProvider(PaymentsService)
      .useValue(Object.create(PaymentsService.prototype, { prisma: { value: prisma } }))
      .compile();
    return module.get(PaymentsService);
  };

  const assert = (ids: string[]) =>
    (PaymentsService.prototype as any).assertCoversWholeSet.call({ prisma }, 'ev-1', ids);

  beforeEach(async () => {
    prisma = { photo: { count: jest.fn() }, photoBib: { findMany: jest.fn() } };
  });

  it('acepta cuando son todas las del evento', async () => {
    prisma.photo.count.mockResolvedValue(3);
    await expect(assert(['a', 'b', 'c'])).resolves.toBeUndefined();
  });

  it('acepta cuando son todas las de un dorsal', async () => {
    prisma.photo.count.mockResolvedValue(500);
    prisma.photoBib.findMany
      .mockResolvedValueOnce([{ bib: '313' }])
      .mockResolvedValueOnce([{ photoId: 'a' }, { photoId: 'b' }]);
    await expect(assert(['a', 'b'])).resolves.toBeUndefined();
  });

  it('RECHAZA fotografías sueltas al precio del lote', async () => {
    // El abuso: cien fotografías cualesquiera por el precio de "todas".
    prisma.photo.count.mockResolvedValue(2000);
    prisma.photoBib.findMany
      .mockResolvedValueOnce([{ bib: '313' }])
      .mockResolvedValueOnce([{ photoId: 'a' }, { photoId: 'b' }, { photoId: 'z' }]);
    await expect(assert(['a', 'b'])).rejects.toThrow(BadRequestException);
  });

  it('RECHAZA mezclar fotografías de varios dorsales', async () => {
    prisma.photo.count.mockResolvedValue(2000);
    prisma.photoBib.findMany
      .mockResolvedValueOnce([{ bib: '313' }, { bib: '414' }])
      .mockResolvedValueOnce([{ photoId: 'a' }])
      .mockResolvedValueOnce([{ photoId: 'b' }]);
    await expect(assert(['a', 'b'])).rejects.toThrow(BadRequestException);
  });

  it('RECHAZA cuando el evento no tiene fotografías publicadas', async () => {
    prisma.photo.count.mockResolvedValue(0);
    prisma.photoBib.findMany.mockResolvedValue([]);
    await expect(assert(['a'])).rejects.toThrow(BadRequestException);
  });
});
