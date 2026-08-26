import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { PaymentsService } from './payments.service';

/**
 * Barrido periódico de liquidaciones pendientes.
 *
 * Una venta se cobra aunque el fotógrafo no haya terminado su alta en Stripe:
 * bloquearla sería peor, porque el atleta ya quiere su fotografía. El asiento
 * queda esperando con el motivo anotado, y hasta ahora solo se recuperaba
 * llamando a mano a un endpoint que no estaba en ninguna pantalla. Es decir:
 * quien vendía antes de completar su alta no cobraba nunca.
 *
 * Cada hora es suficiente. El camino rápido es el webhook `account.updated`,
 * que dispara el barrido en cuanto alguien termina su alta; esto es la red por
 * si ese aviso no llega.
 */
@Injectable()
export class SettlementSweeperService {
  private readonly logger = new Logger(SettlementSweeperService.name);

  constructor(private readonly payments: PaymentsService) {}

  @Cron('7 * * * *')
  async sweep(): Promise<void> {
    try {
      const result = await this.payments.sweepPendingSettlements();
      if (result.attempted === 0) return;
      this.logger.log(
        `Liquidaciones pendientes: ${result.settled.length} resueltas, ${result.failed.length} siguen esperando`,
      );
      for (const failure of result.failed) {
        this.logger.warn(`Pedido ${failure.orderId} sigue sin liquidar: ${failure.error}`);
      }
    } catch (error) {
      this.logger.error(
        `El barrido de liquidaciones falló: ${error instanceof Error ? error.message : 'desconocido'}`,
      );
    }
  }
}
