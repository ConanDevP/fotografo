import { Test } from '@nestjs/testing';
import { ScheduleModule, SchedulerRegistry } from '@nestjs/schedule';

import { SettlementSweeperService } from './settlement-sweeper.service';
import { PaymentsService } from './payments.service';
import { PlanSubscriptionsService } from '../billing/plan-subscriptions.service';

describe('SettlementSweeperService', () => {
  const payments = { sweepPendingSettlements: jest.fn() };
  const planSubscriptions = { reconcileSubscriptions: jest.fn().mockResolvedValue({ checked: 0, repaired: [] }) };

  const build = async () => {
    const module = await Test.createTestingModule({
      providers: [
        SettlementSweeperService,
        { provide: PaymentsService, useValue: payments },
        { provide: PlanSubscriptionsService, useValue: planSubscriptions },
      ],
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

  it('reconcilia suscripciones sin filtrar, y aguanta un fallo', async () => {
    const service = await build();
    planSubscriptions.reconcileSubscriptions.mockResolvedValueOnce({ checked: 5, repaired: ['ws-1: Profesional registrado'] });

    await service.reconcile();
    expect(planSubscriptions.reconcileSubscriptions).toHaveBeenCalledWith();

    // Un fallo de Stripe no debe matar el cron hasta el próximo reinicio.
    planSubscriptions.reconcileSubscriptions.mockRejectedValueOnce(new Error('Stripe caído'));
    await expect(service.reconcile()).resolves.toBeUndefined();
  });

  it('queda registrado para ejecutarse cada hora', async () => {
    // Un cron que no llega a registrarse no falla: simplemente nadie cobra, y
    // eso no se nota hasta que alguien reclama su dinero.
    const module = await Test.createTestingModule({
      imports: [ScheduleModule.forRoot()],
      providers: [
        SettlementSweeperService,
        { provide: PaymentsService, useValue: payments },
        { provide: PlanSubscriptionsService, useValue: planSubscriptions },
      ],
    }).compile();
    const app = module.createNestApplication();
    await app.init();

    const expressions = [...app.get(SchedulerRegistry).getCronJobs().values()].map(job =>
      String((job as any).cronTime.source),
    );
    expect(expressions).toContain('7 * * * *');
    // La reconciliación es la red del cobro: si no se registra, un webhook
    // perdido deja a alguien pagando sin plan para siempre.
    expect(expressions).toContain('23 */6 * * *');

    await app.close();
  });
});
