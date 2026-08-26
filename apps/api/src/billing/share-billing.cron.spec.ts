import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ScheduleModule, SchedulerRegistry } from '@nestjs/schedule';

import { ShareBillingService } from './share-billing.service';
import { PrismaService } from '../common/services/prisma.service';

jest.mock('stripe', () => ({ __esModule: true, default: jest.fn().mockImplementation(() => ({})) }));

/**
 * Un cron que no llega a registrarse no falla: simplemente no cobra nunca, y
 * eso no se nota hasta que faltan los ingresos de un mes. Por eso se comprueba.
 */
describe('Cron de liquidación mensual', () => {
  it('queda registrado para el día 1 de cada mes', async () => {
    const module = await Test.createTestingModule({
      imports: [ScheduleModule.forRoot()],
      providers: [
        ShareBillingService,
        { provide: PrismaService, useValue: {} },
        { provide: ConfigService, useValue: { get: (_k: string, fallback?: any) => fallback } },
      ],
    }).compile();

    const app = module.createNestApplication();
    await app.init();

    const jobs = app.get(SchedulerRegistry).getCronJobs();
    const expressions = [...jobs.values()].map(job => String((job as any).cronTime.source));

    expect(expressions).toContain('0 3 1 * *');

    await app.close();
  });
});
