import { Test } from '@nestjs/testing';
import { ScheduleModule, SchedulerRegistry } from '@nestjs/schedule';

import { SettlementSweeperService } from './settlement-sweeper.service';
import { PaymentsService } from './payments.service';

describe('SettlementSweeperService', () => {
  const payments = { sweepPendingSettlements: jest.fn() };

  const build = async () => {
    const module = await Test.createTestingModule({
      providers: [SettlementSweeperService, { provide: PaymentsService, useValue: payments }],
    }).compile();
    return module.get(SettlementSweeperService);
  };

  beforeEach(() => jest.clearAllMocks());

  it('barre todos los pendientes, sin filtrar por beneficiario', async () => {
    payments.sweepPendingSettlements.mockResolvedValue({ attempted: 2, settled: ['a', 'b'], failed: [] });
    const service = await build();

    await service.sweep();

    // Sin argumento: el cron recorre los de todo el mundo, no los de un usuario.
    expect(payments.sweepPendingSettlements).toHaveBeenCalledWith();
  });

  it('no se cae si la liquidación falla', async () => {
    // Una excepción sin capturar dejaría el cron muerto hasta reiniciar la API.
    payments.sweepPendingSettlements.mockRejectedValue(new Error('Stripe caído'));
    const service = await build();

    await expect(service.sweep()).resolves.toBeUndefined();
  });

  it('queda registrado para ejecutarse cada hora', async () => {
    // Un cron que no llega a registrarse no falla: simplemente nadie cobra, y
    // eso no se nota hasta que alguien reclama su dinero.
    const module = await Test.createTestingModule({
      imports: [ScheduleModule.forRoot()],
      providers: [SettlementSweeperService, { provide: PaymentsService, useValue: payments }],
    }).compile();
    const app = module.createNestApplication();
    await app.init();

    const expressions = [...app.get(SchedulerRegistry).getCronJobs().values()].map(job =>
      String((job as any).cronTime.source),
    );
    expect(expressions).toContain('7 * * * *');

    await app.close();
  });
});
