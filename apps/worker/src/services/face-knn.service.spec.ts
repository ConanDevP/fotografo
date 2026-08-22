import { Test, TestingModule } from '@nestjs/testing';

import { FaceKnnService } from './face-knn.service';
import { PrismaService } from '../../../api/src/common/services/prisma.service';

/** Vector unitario en la dirección `axis`, con ruido opcional. */
const vec = (axis: number, noise = 0): number[] =>
  Array.from({ length: 8 }, (_, i) => (i === axis ? 1 : 0) + (i === axis + 1 ? noise : 0));

describe('FaceKnnService', () => {
  let service: FaceKnnService;
  let prisma: any;

  const indexed = (id: string, photoId: string, bib: string, axis: number) => ({
    id,
    photoId,
    embedding: vec(axis),
    faceBibAssociations: [{ bib, method: 'SPATIAL', photoBib: { confidence: 0.9 } }],
  });

  beforeEach(async () => {
    prisma = { faceEmbedding: { findMany: jest.fn().mockResolvedValue([]) } };
    const module: TestingModule = await Test.createTestingModule({
      providers: [FaceKnnService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = module.get<FaceKnnService>(FaceKnnService);
  });

  it('encuentra la cara más parecida del evento', async () => {
    prisma.faceEmbedding.findMany.mockResolvedValue([
      indexed('f1', 'foto-1', '101', 0),
      indexed('f2', 'foto-2', '202', 3),
    ]);

    const [best] = await service.findMatches('ev', vec(0, 0.05), 5);

    expect(best.bib).toBe('101');
    expect(best.distance).toBeLessThan(0.1);
  });

  it('nunca empareja una cara con otra de su misma fotografía', async () => {
    // Dos caras casi idénticas: una en la propia foto, otra en una distinta.
    prisma.faceEmbedding.findMany.mockResolvedValue([
      indexed('propia', 'foto-1', 'MISMA-FOTO', 0),
      indexed('ajena', 'foto-2', 'OTRA-FOTO', 0),
    ]);

    const matches = await service.findMatches('ev', vec(0), 5, 'foto-1');

    expect(matches.map(m => m.bib)).not.toContain('MISMA-FOTO');
    expect(matches[0].bib).toBe('OTRA-FOTO');
  });

  it('reutiliza el índice entre consultas en vez de releer el evento', async () => {
    prisma.faceEmbedding.findMany.mockResolvedValue([indexed('f1', 'foto-1', '101', 0)]);

    await service.findMatches('ev', vec(0), 5);
    await service.findMatches('ev', vec(0), 5);
    await service.findMatches('ev', vec(0), 5);

    // Una sola lectura: antes se invalidaba antes de cada fotografía y el coste
    // total crecía de forma cuadrática con el tamaño del evento.
    expect(prisma.faceEmbedding.findMany).toHaveBeenCalledTimes(1);
  });

  it('incorpora una asociación nueva sin volver a leer la base de datos', async () => {
    prisma.faceEmbedding.findMany.mockResolvedValue([indexed('f1', 'foto-1', '101', 0)]);
    await service.findMatches('ev', vec(0), 5);

    service.addToIndex('ev', {
      faceEmbeddingId: 'f9',
      photoId: 'foto-9',
      bib: '999',
      embedding: vec(3),
    });

    const matches = await service.findMatches('ev', vec(3), 5);

    expect(matches[0].bib).toBe('999');
    expect(prisma.faceEmbedding.findMany).toHaveBeenCalledTimes(1);
  });

  it('no duplica una entrada ya presente en el índice', async () => {
    prisma.faceEmbedding.findMany.mockResolvedValue([indexed('f1', 'foto-1', '101', 0)]);
    await service.findMatches('ev', vec(0), 5);

    const entry = { faceEmbeddingId: 'f1', photoId: 'foto-1', bib: '101', embedding: vec(0) };
    service.addToIndex('ev', entry);
    service.addToIndex('ev', entry);

    expect(await service.findMatches('ev', vec(0), 10)).toHaveLength(1);
  });
});
