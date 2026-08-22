import { Test, TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';

import { BatchProgressService } from '../services/batch-progress.service';
import { PrismaService } from '../../../api/src/common/services/prisma.service';
import { QUEUES } from '@shared/constants';

describe('Repaso de inferencia al cerrar el lote', () => {
  let service: BatchProgressService;
  let prisma: any;
  let queue: any;

  /** Lote con `done` de `total` elementos terminados y ninguno fallido. */
  const givenBatch = (status: string, total: number, done: number) => {
    prisma.batchUploadJob.findUnique.mockResolvedValue({ status, totalFiles: total, eventId: 'ev-1' });
    prisma.batchUploadItem.count.mockImplementation(({ where }: any) => {
      if (where?.status?.in) return Promise.resolve(done);
      if (where?.status === 'FAILED') return Promise.resolve(0);
      if (where?.photoId) return Promise.resolve(done);
      if (Object.keys(where).length === 1) return Promise.resolve(total);
      return Promise.resolve(0);
    });
  };

  beforeEach(async () => {
    queue = { add: jest.fn().mockResolvedValue({ id: 'j1' }) };
    prisma = {
      batchUploadJob: { findUnique: jest.fn(), update: jest.fn().mockResolvedValue({}) },
      batchUploadItem: { count: jest.fn().mockResolvedValue(0), findFirst: jest.fn() },
      photo: { findUnique: jest.fn() },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BatchProgressService,
        { provide: PrismaService, useValue: prisma },
        { provide: getQueueToken(QUEUES.INFER_BIBS), useValue: queue },
      ],
    }).compile();

    service = module.get<BatchProgressService>(BatchProgressService);
  });

  it('encola el repaso del evento cuando el lote termina', async () => {
    givenBatch('PROCESSING', 3, 3);

    await service.reconcile('lote-1');

    expect(queue.add).toHaveBeenCalledWith(
      'infer-bibs',
      { eventId: 'ev-1', sweep: true },
      expect.objectContaining({ jobId: 'sweep-ev-1-lote-1' }),
    );
  });

  it('no lo encola mientras el lote sigue procesando', async () => {
    givenBatch('PROCESSING', 10, 4);

    await service.reconcile('lote-1');

    expect(queue.add).not.toHaveBeenCalled();
  });

  it('no lo repite si el lote ya estaba cerrado', async () => {
    givenBatch('COMPLETED', 3, 3);

    await service.reconcile('lote-1');

    expect(queue.add).not.toHaveBeenCalled();
  });

  it('usa un identificador distinto por lote, para que cada subida repase', async () => {
    givenBatch('PROCESSING', 1, 1);
    await service.reconcile('lote-A');
    givenBatch('PROCESSING', 1, 1);
    await service.reconcile('lote-B');

    const ids = queue.add.mock.calls.map((c: any[]) => c[2].jobId);
    // Con un id fijo, BullMQ descartaría el segundo repaso en silencio.
    expect(new Set(ids).size).toBe(2);
  });
});
