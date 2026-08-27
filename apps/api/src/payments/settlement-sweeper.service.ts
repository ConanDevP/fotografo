import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { PaymentsService } from './payments.service';
import { PlanSubscriptionsService } from '../billing/plan-subscriptions.service';

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

  constructor(
    private readonly payments: PaymentsService,
    private readonly planSubscriptions: PlanSubscriptionsService,
  ) {}

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

  /**
   * Cada seis horas: ¿hay alguien pagando en Stripe que aquí no tenga plan?
   *
   * Menos frecuente que el barrido de liquidaciones porque es una red, no el
   * camino normal —ese es el webhook—. Pero sin ella, un webhook perdido deja
   * a alguien pagando por nada de forma indefinida.
   */
  @Cron('23 */6 * * *')
  async reconcile(): Promise<void> {
    try {
      const result = await this.planSubscriptions.reconcileSubscriptions();
      if (result.repaired.length === 0) return;
      this.logger.warn(
        `Reconciliación de suscripciones: ${result.repaired.length} arregladas de ${result.checked} revisadas`,
      );
      for (const entry of result.repaired) this.logger.warn(`  ${entry}`);
    } catch (error) {
      this.logger.error(
        `La reconciliación de suscripciones falló: ${error instanceof Error ? error.message : 'desconocido'}`,
      );
    }
  }
}
