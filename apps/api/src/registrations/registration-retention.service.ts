import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { PrismaService } from '../common/services/prisma.service';
import { REGISTRATION_RETENTION_DAYS } from '@shared/registration';

/** Los datos de contacto de corredores no se guardan indefinidamente: se borran meses después del evento. */
@Injectable()
export class RegistrationRetentionService {
  private readonly logger = new Logger(RegistrationRetentionService.name);

  constructor(private readonly prisma: PrismaService) {}

  @Cron('0 5 * * *')
  async run(now: Date = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - REGISTRATION_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const { count } = await this.prisma.bibSubscription.deleteMany({
      where: { event: { date: { lt: cutoff } } },
    });
    if (count) this.logger.log(`Registros de corredores borrados por antigüedad: ${count}`);
    // El historial de avisos fallidos solo sirve para diagnosticar: 90 días bastan.
    await this.prisma.deliveryIssue.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000) } } });
    return count;
  }
}
