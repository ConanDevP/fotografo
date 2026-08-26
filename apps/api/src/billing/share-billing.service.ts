import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { ShareChargeStatus } from '@prisma/client';
import Stripe from 'stripe';

import { PrismaService } from '../common/services/prisma.service';

/** Importe mínimo que Stripe acepta en un cargo. Por debajo se arrastra al mes siguiente. */
const MIN_CHARGE_CENTS = 50;

/**
 * Liquidación mensual del modo compartir.
 *
 * Las fotografías añadidas a un evento gratuito YA publicado no se cobran en el
 * momento —serían microcargos de céntimos—, sino que se acumulan en
 * `pendingShareChargeCents` y se cobran juntas una vez al mes.
 *
 * No va por la suscripción de Stripe porque el importe es variable y porque los
 * espacios del plan gratuito también lo generan, y esos no tienen suscripción.
 */
@Injectable()
export class ShareBillingService {
  private readonly logger = new Logger(ShareBillingService.name);
  private readonly stripe: Stripe | null;
  private readonly demoPayments: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    const secretKey = this.config.get<string>('STRIPE_SECRET_KEY');
    this.stripe = secretKey ? new Stripe(secretKey, { apiVersion: '2022-11-15' }) : null;
    this.demoPayments = this.config.get('DEMO_PAYMENTS', 'false') === 'true';
  }

  /**
   * Día 1 de cada mes a las 03:00. Cobra lo acumulado durante el mes anterior,
   * que es el periodo que se factura.
   */
  @Cron('0 3 1 * *')
  async runMonthlyBilling(): Promise<void> {
    const period = this.previousPeriod();
    this.logger.log(`Liquidando el modo compartir del periodo ${period}`);
    const result = await this.billPeriod(period);
    this.logger.log(
      `Periodo ${period}: ${result.charged} cobrados, ${result.failed} fallidos, ${result.skipped} sin importe suficiente`,
    );
  }

  /** Periodo anterior al actual, en formato AAAA-MM. */
  previousPeriod(now = new Date()): string {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
  }

  async billPeriod(period: string): Promise<{ charged: number; failed: number; skipped: number }> {
    const pending = await this.prisma.workspace.findMany({
      where: { deletedAt: null, pendingShareChargeCents: { gt: 0 } },
      select: {
        id: true,
        name: true,
        pendingShareChargeCents: true,
        stripeCustomerId: true,
        defaultPaymentMethodId: true,
      },
    });

    let charged = 0;
    let failed = 0;
    let skipped = 0;

    for (const workspace of pending) {
      // Los céntimos se acumulan con decimales porque la tarifa por fotografía
      // baja de un céntimo. Se redondea a la baja: lo que sobra queda pendiente.
      const accrued = Number(workspace.pendingShareChargeCents);
      const amount = Math.floor(accrued);

      if (amount < MIN_CHARGE_CENTS) {
        skipped += 1;
        continue;
      }

      const outcome = await this.billWorkspace(workspace, period, amount);
      if (outcome === 'charged') charged += 1;
      else if (outcome === 'failed') failed += 1;
      else skipped += 1;
    }

    return { charged, failed, skipped };
  }

  private async billWorkspace(
    workspace: {
      id: string;
      name: string;
      stripeCustomerId: string | null;
      defaultPaymentMethodId: string | null;
    },
    period: string,
    amount: number,
  ): Promise<'charged' | 'failed' | 'skipped'> {
    // La clave única (espacio, periodo) es lo que impide cobrar dos veces si el
    // cron se dispara de nuevo. Un periodo ya pagado se sale aquí.
    const existing = await this.prisma.shareUsageCharge.findUnique({
      where: { workspaceId_period: { workspaceId: workspace.id, period } },
      select: { status: true },
    });
    if (existing?.status === ShareChargeStatus.PAID) return 'skipped';

    if (this.demoPayments || !this.stripe) {
      this.logger.warn(
        `Sin pasarela activa: ${workspace.name} no paga los ${this.money(amount)} del periodo ${period}`,
      );
      return 'skipped';
    }

    if (!workspace.stripeCustomerId || !workspace.defaultPaymentMethodId) {
      await this.record(workspace.id, period, amount, ShareChargeStatus.FAILED, {
        failureReason: 'El espacio no tiene método de pago',
      });
      this.logger.warn(`${workspace.name} debe ${this.money(amount)} y no tiene método de pago`);
      return 'failed';
    }

    await this.record(workspace.id, period, amount, ShareChargeStatus.PENDING, {});

    try {
      const intent = await this.stripe.paymentIntents.create(
        {
          amount,
          currency: 'usd',
          customer: workspace.stripeCustomerId,
          payment_method: workspace.defaultPaymentMethodId,
          off_session: true,
          confirm: true,
          description: `Consumo del modo compartir · ${period}`,
          metadata: { workspaceId: workspace.id, period },
        },
        { idempotencyKey: `lucilamon-share-usage-${workspace.id}-${period}` },
      );

      // Descontar lo cobrado en vez de poner a cero: durante el cobro pueden
      // haberse acumulado céntimos nuevos que pertenecen al mes siguiente.
      await this.prisma.$transaction([
        this.prisma.workspace.update({
          where: { id: workspace.id },
          data: { pendingShareChargeCents: { decrement: amount } },
        }),
        this.prisma.shareUsageCharge.update({
          where: { workspaceId_period: { workspaceId: workspace.id, period } },
          data: {
            status: ShareChargeStatus.PAID,
            stripePaymentIntentId: intent.id,
            chargedAt: new Date(),
            failureReason: null,
          },
        }),
      ]);

      this.logger.log(`${workspace.name}: cobrados ${this.money(amount)} del periodo ${period}`);
      return 'charged';
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Error desconocido';
      // El importe NO se descuenta: sigue pendiente y se reintenta el mes que
      // viene acumulado con el nuevo consumo.
      await this.record(workspace.id, period, amount, ShareChargeStatus.FAILED, {
        failureReason: reason,
      });
      this.logger.error(`No se pudo cobrar a ${workspace.name} el periodo ${period}: ${reason}`);
      return 'failed';
    }
  }

  private async record(
    workspaceId: string,
    period: string,
    amountCents: number,
    status: ShareChargeStatus,
    extra: { failureReason?: string | null },
  ) {
    await this.prisma.shareUsageCharge.upsert({
      where: { workspaceId_period: { workspaceId, period } },
      create: { workspaceId, period, amountCents, status, ...extra },
      update: { amountCents, status, ...extra },
    });
  }

  private money(cents: number): string {
    return `$${(cents / 100).toFixed(2)}`;
  }
}
