import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { MailerService } from '../common/services/mailer.service';
import { PrismaService } from '../common/services/prisma.service';

/** Asientos que se le deben pagar a una persona (el resto del reparto es de la plataforma o la pasarela). */
const PAYABLE_TYPES = ['PHOTOGRAPHER_EARNING', 'ORGANIZER_COMMISSION'] as const;
const OPEN_STATUSES = ['AVAILABLE', 'PENDING'] as const;

export const PAYOUT_METHODS = ['BANK_TRANSFER', 'PAYONEER', 'PAYPAL', 'CASH', 'OTHER'] as const;
export type PayoutMethod = (typeof PAYOUT_METHODS)[number];

/** Cómo se recuperó un importe pagado a mano que luego se reembolsó. */
export const RECOVERY_METHODS = ['BANK_TRANSFER', 'PAYONEER', 'PAYPAL', 'CASH', 'OFFSET', 'WRITE_OFF', 'OTHER'] as const;
export type RecoveryMethod = (typeof RECOVERY_METHODS)[number];

/** Marca en `failureReason` de un importe ya recuperado: es lo que impide recuperarlo dos veces. */
export const MANUAL_PAYOUT_RECOVERED = 'Este importe se devolvió tras el reembolso del pedido y ya está ajustado.';

const METHOD_LABEL: Record<PayoutMethod, string> = {
  BANK_TRANSFER: 'Transferencia bancaria',
  PAYONEER: 'Payoneer',
  PAYPAL: 'PayPal',
  CASH: 'Efectivo',
  OTHER: 'Otro',
};

const escapeHtml = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface MarkRecoveredInput {
  entryIds: string[];
  method: RecoveryMethod;
  /** Obligatoria salvo en las opciones que no mueven dinero (descuento o condonación). */
  reference?: string;
  note?: string;
}

export interface MarkPaidInput {
  entryIds: string[];
  method: PayoutMethod;
  /** Número de transferencia, id de Payoneer, recibo… Lo que permita encontrar el pago. */
  reference: string;
  note?: string;
}

/**
 * Pagos hechos a mano a quien no puede recibir transferencias de Stripe.
 *
 * La venta ya está cobrada y repartida en el libro; aquí solo se deja constancia
 * de que se pagó, a quién, por qué medio y con qué referencia. Un asiento
 * `PAID_OUT` sin `externalTransferId` es, por definición, un pago manual.
 */
@Injectable()
export class ManualPayoutsService {
  private readonly logger = new Logger(ManualPayoutsService.name);

  constructor(
    private readonly prisma: PrismaService,
    // Sin correo configurado el pago se registra igual; solo no se avisa.
    @Optional() private readonly mailer?: MailerService,
    @Optional() private readonly config?: ConfigService,
  ) {}

  /** Lo que se debe, agrupado por persona y moneda, más lo que habrá que recuperar y el historial. */
  async overview() {
    const entries = await this.prisma.ledgerEntry.findMany({
      where: {
        type: { in: [...PAYABLE_TYPES] },
        status: { in: [...OPEN_STATUSES] },
        amountCents: { gt: 0 },
        order: { status: 'PAID', refundRequestedAt: null },
      },
      orderBy: { createdAt: 'asc' },
      take: 5000,
      select: {
        id: true,
        type: true,
        amountCents: true,
        currency: true,
        createdAt: true,
        orderId: true,
        workspace: { select: { name: true } },
        beneficiaryUser: {
          select: {
            id: true,
            email: true,
            name: true,
            stripeAccountId: true,
            stripeOnboardingCompleted: true,
            stripeChargesEnabled: true,
            stripePayoutsEnabled: true,
          },
        },
        order: { select: { paidAt: true, createdAt: true, event: { select: { name: true } } } },
      },
    });

    type Group = {
      key: string;
      beneficiary: { id: string; email: string; name: string | null } | null;
      stripeReady: boolean;
      currency: string;
      totalCents: number;
      entryCount: number;
      oldestAt: Date;
      entries: Array<{
        id: string;
        type: string;
        amountCents: number;
        eventName: string | null;
        workspaceName: string | null;
        soldAt: Date;
      }>;
    };
    const groups = new Map<string, Group>();
    for (const entry of entries) {
      const user = entry.beneficiaryUser;
      const currency = (entry.currency || 'USD').toUpperCase();
      const key = `${user?.id ?? 'sin-beneficiario'}|${currency}`;
      const group = groups.get(key) ?? {
        key,
        beneficiary: user ? { id: user.id, email: user.email, name: user.name ?? null } : null,
        // Si ya puede recibir por Stripe, el barrido automático le transferirá solo.
        stripeReady: Boolean(
          user?.stripeAccountId && user.stripeOnboardingCompleted && user.stripeChargesEnabled && user.stripePayoutsEnabled,
        ),
        currency,
        totalCents: 0,
        entryCount: 0,
        oldestAt: entry.order?.paidAt ?? entry.createdAt,
        entries: [],
      };
      group.totalCents += entry.amountCents;
      group.entryCount += 1;
      group.entries.push({
        id: entry.id,
        type: entry.type,
        amountCents: entry.amountCents,
        eventName: entry.order?.event?.name ?? null,
        workspaceName: entry.workspace?.name ?? null,
        soldAt: entry.order?.paidAt ?? entry.order?.createdAt ?? entry.createdAt,
      });
      groups.set(key, group);
    }

    // Pagado a mano y después devuelto o disputado: el importe hay que pedírselo de vuelta.
    const toRecover = await this.prisma.ledgerEntry.findMany({
      where: {
        type: { in: [...PAYABLE_TYPES] },
        status: 'PAID_OUT',
        externalTransferId: null,
        order: { status: { in: ['REFUNDED', 'DISPUTED'] } },
        OR: [{ failureReason: null }, { failureReason: { not: MANUAL_PAYOUT_RECOVERED } }],
      },
      orderBy: { paidOutAt: 'desc' },
      take: 200,
      select: {
        id: true,
        amountCents: true,
        currency: true,
        paidOutAt: true,
        beneficiaryUser: { select: { id: true, email: true, name: true } },
        order: { select: { status: true, event: { select: { name: true } } } },
      },
    });

    const history = await this.prisma.auditLog.findMany({
      where: { action: 'MANUAL_PAYOUT' },
      orderBy: { createdAt: 'desc' },
      take: 30,
      select: { id: true, createdAt: true, data: true },
    });

    return {
      pending: [...groups.values()].sort((a, b) => b.totalCents - a.totalCents),
      toRecover: toRecover.map(entry => ({
        id: entry.id,
        amountCents: entry.amountCents,
        currency: entry.currency,
        paidAt: entry.paidOutAt,
        orderStatus: entry.order?.status ?? null,
        eventName: entry.order?.event?.name ?? null,
        beneficiary: entry.beneficiaryUser,
      })),
      history: history.map(row => ({ id: row.id, at: row.createdAt, ...(row.data as Record<string, unknown>) })),
    };
  }

  /**
   * Marca como pagados los asientos indicados. Todos o ninguno: si alguno cambió
   * de estado mientras se preparaba el pago (otro administrador, el barrido de
   * Stripe), no se marca nada.
   */
  async markPaid(adminUserId: string, input: MarkPaidInput) {
    const ids = [...new Set(input.entryIds)];
    if (ids.length === 0) throw new BadRequestException('Selecciona al menos un importe');
    if (!PAYOUT_METHODS.includes(input.method)) throw new BadRequestException('Medio de pago no válido');
    const reference = input.reference?.trim();
    if (!reference) throw new BadRequestException('Indica la referencia del pago (número de transferencia, recibo…)');

    const entries = await this.prisma.ledgerEntry.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        type: true,
        status: true,
        amountCents: true,
        currency: true,
        orderId: true,
        beneficiaryUserId: true,
        beneficiaryUser: {
          select: {
            email: true,
            name: true,
            stripeAccountId: true,
            stripeOnboardingCompleted: true,
            stripeChargesEnabled: true,
            stripePayoutsEnabled: true,
          },
        },
        order: { select: { status: true, refundRequestedAt: true, settlementStatus: true } },
      },
    });
    if (entries.length !== ids.length) throw new NotFoundException('Alguno de los importes ya no existe');

    const beneficiaryId = entries[0].beneficiaryUserId;
    if (!beneficiaryId) throw new BadRequestException('Estos importes no tienen beneficiario: no se pueden pagar');
    const currency = entries[0].currency.toUpperCase();
    const user = entries[0].beneficiaryUser;

    for (const entry of entries) {
      if (entry.beneficiaryUserId !== beneficiaryId) {
        throw new BadRequestException('Cada pago es a una sola persona: separa los importes por beneficiario');
      }
      if (entry.currency.toUpperCase() !== currency) {
        throw new BadRequestException('Cada pago es en una sola moneda: separa los importes por moneda');
      }
      if (!(PAYABLE_TYPES as readonly string[]).includes(entry.type) || entry.amountCents <= 0) {
        throw new BadRequestException('Alguno de los asientos no es un importe pagable');
      }
      if (!(OPEN_STATUSES as readonly string[]).includes(entry.status)) {
        throw new ConflictException('Alguno de los importes ya se pagó o se revirtió: recarga la pantalla');
      }
      if (entry.order?.status !== 'PAID' || entry.order.refundRequestedAt) {
        throw new BadRequestException('Alguno de los pedidos fue reembolsado o está en disputa: no se paga');
      }
      if (entry.order.settlementStatus === 'PROCESSING') {
        throw new ConflictException('Se está liquidando un pedido por Stripe en este momento. Inténtalo en unos minutos');
      }
    }

    // Si ya puede cobrar por Stripe, el barrido automático le transferirá solo.
    // Pagarle a mano además duplicaría el pago.
    if (user?.stripeAccountId && user.stripeOnboardingCompleted && user.stripeChargesEnabled && user.stripePayoutsEnabled) {
      throw new BadRequestException('Esta persona ya puede recibir transferencias de Stripe: se le pagará automáticamente');
    }

    const totalCents = entries.reduce((sum, entry) => sum + entry.amountCents, 0);
    const now = new Date();
    const payout = {
      batchId: randomUUID(),
      method: input.method,
      reference,
      note: input.note?.trim() || null,
      paidBy: adminUserId,
      paidAt: now.toISOString(),
      totalCents,
      entryCount: entries.length,
    };
    const orderIds = [...new Set(entries.map(entry => entry.orderId))];

    await this.prisma.$transaction(async tx => {
      // La condición sobre el estado es la que impide pagar dos veces el mismo
      // importe si dos personas lo marcan a la vez.
      const claim = await tx.ledgerEntry.updateMany({
        where: { id: { in: ids }, status: { in: [...OPEN_STATUSES] } },
        data: { status: 'PAID_OUT', paidOutAt: now, failureReason: null, metadata: { manualPayout: payout } },
      });
      if (claim.count !== ids.length) {
        throw new ConflictException('Algún importe cambió de estado mientras se preparaba el pago: recarga la pantalla');
      }

      // Un pedido sin importes pendientes queda liquidado.
      for (const orderId of orderIds) {
        const remaining = await tx.ledgerEntry.count({
          where: {
            orderId,
            type: { in: [...PAYABLE_TYPES] },
            status: { in: [...OPEN_STATUSES] },
            amountCents: { gt: 0 },
          },
        });
        if (remaining === 0) {
          await tx.order.updateMany({
            where: { id: orderId, status: 'PAID', settlementStatus: { in: ['PENDING', 'PARTIAL', 'FAILED'] } },
            data: { settlementStatus: 'SETTLED', settledAt: now, settlementError: null },
          });
        }
      }

      await tx.auditLog.create({
        data: {
          userId: adminUserId,
          action: 'MANUAL_PAYOUT',
          data: {
            ...payout,
            beneficiaryUserId: beneficiaryId,
            beneficiaryEmail: user?.email ?? null,
            currency,
            entryIds: ids,
          },
        },
      });
    });

    this.logger.log(`Pago manual ${payout.batchId}: ${totalCents} ${currency} a ${beneficiaryId} (${input.method}, ${reference})`);
    const notified = await this.notifyPayout({
      email: user?.email ?? null,
      name: user?.name ?? null,
      totalCents,
      currency,
      entryCount: entries.length,
      method: input.method,
      reference,
    });
    return { batchId: payout.batchId, totalCents, currency, entryCount: entries.length, notified };
  }

  /**
   * Avisa a la persona de que se le pagó. Va después de registrar el pago y
   * nunca lo deshace: si el correo falla, el pago sigue anotado y se informa.
   * La nota interna no se incluye.
   */
  private async notifyPayout(info: {
    email: string | null;
    name: string | null;
    totalCents: number;
    currency: string;
    entryCount: number;
    method: PayoutMethod;
    reference: string;
  }): Promise<boolean> {
    if (!info.email || !this.mailer?.isConfigured) return false;
    try {
      let amount = `${(info.totalCents / 100).toFixed(2)} ${info.currency}`;
      try {
        amount = new Intl.NumberFormat('es', { style: 'currency', currency: info.currency }).format(info.totalCents / 100);
      } catch {
        /* moneda desconocida: se queda el formato simple */
      }
      const appUrl = (this.config?.get<string>('APP_URL') || 'http://localhost:3000').replace(/\/$/, '');
      const sales = `${info.entryCount} ${info.entryCount === 1 ? 'venta' : 'ventas'}`;
      return await this.mailer.send({
        to: info.email,
        subject: `Te enviamos un pago de ${amount}`,
        html: `<div style="font-family:sans-serif;max-width:520px">
<h2 style="margin:0 0 8px">Te enviamos un pago</h2>
<p>Hola${info.name ? ` ${escapeHtml(info.name)}` : ''}, registramos un pago por <strong>${escapeHtml(amount)}</strong> correspondiente a ${sales} en LucilaMon.</p>
<p style="margin:0">Medio: <strong>${escapeHtml(METHOD_LABEL[info.method])}</strong><br>Referencia: <strong>${escapeHtml(info.reference)}</strong></p>
<p>Si no lo ves en tu cuenta en unos días, responde a este correo con la referencia. Puedes ver el detalle en <a href="${escapeHtml(appUrl)}/dashboard/billing">tus ganancias</a>.</p>
</div>`,
      });
    } catch (error) {
      this.logger.warn(`No se pudo avisar del pago: ${error instanceof Error ? error.message : 'desconocido'}`);
      return false;
    }
  }

  /**
   * Deja constancia de que un importe pagado a mano y luego reembolsado ya se
   * recuperó (o se descontó de otro pago, o se asume como pérdida). No mueve
   * dinero: eso se hizo por fuera. Todos o ninguno, y no se puede repetir.
   */
  async markRecovered(adminUserId: string, input: MarkRecoveredInput) {
    const ids = [...new Set(input.entryIds)];
    if (ids.length === 0) throw new BadRequestException('Selecciona al menos un importe');
    if (!RECOVERY_METHODS.includes(input.method)) throw new BadRequestException('Medio no válido');
    const reference = input.reference?.trim() || null;
    const movesMoney = input.method !== 'OFFSET' && input.method !== 'WRITE_OFF';
    if (movesMoney && !reference) throw new BadRequestException('Indica la referencia del dinero recuperado');

    const entries = await this.prisma.ledgerEntry.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        type: true,
        status: true,
        amountCents: true,
        currency: true,
        externalTransferId: true,
        failureReason: true,
        metadata: true,
        beneficiaryUserId: true,
        order: { select: { status: true } },
      },
    });
    if (entries.length !== ids.length) throw new NotFoundException('Alguno de los importes ya no existe');

    const beneficiaryId = entries[0].beneficiaryUserId;
    const currency = entries[0].currency.toUpperCase();
    for (const entry of entries) {
      if (entry.beneficiaryUserId !== beneficiaryId || entry.currency.toUpperCase() !== currency) {
        throw new BadRequestException('Cada ajuste es a una sola persona y una sola moneda');
      }
      if (
        !(PAYABLE_TYPES as readonly string[]).includes(entry.type) ||
        entry.status !== 'PAID_OUT' ||
        entry.externalTransferId ||
        !['REFUNDED', 'DISPUTED'].includes(entry.order?.status ?? '')
      ) {
        throw new BadRequestException('Alguno de los importes no está pendiente de recuperar');
      }
      if (entry.failureReason === MANUAL_PAYOUT_RECOVERED) {
        throw new ConflictException('Alguno de los importes ya se recuperó: recarga la pantalla');
      }
    }

    const now = new Date();
    const recovery = {
      batchId: randomUUID(),
      method: input.method,
      reference,
      note: input.note?.trim() || null,
      recoveredBy: adminUserId,
      recoveredAt: now.toISOString(),
    };
    const totalCents = entries.reduce((sum, entry) => sum + entry.amountCents, 0);

    await this.prisma.$transaction(async tx => {
      for (const entry of entries) {
        const previous = (entry.metadata && typeof entry.metadata === 'object' ? entry.metadata : {}) as Record<string, unknown>;
        // La condición sobre failureReason impide recuperar dos veces lo mismo
        // si dos personas lo marcan a la vez.
        const claim = await tx.ledgerEntry.updateMany({
          where: {
            id: entry.id,
            status: 'PAID_OUT',
            externalTransferId: null,
            OR: [{ failureReason: null }, { failureReason: { not: MANUAL_PAYOUT_RECOVERED } }],
          },
          data: { failureReason: MANUAL_PAYOUT_RECOVERED, metadata: { ...previous, recovery } },
        });
        if (claim.count !== 1) {
          throw new ConflictException('Algún importe cambió mientras se preparaba el ajuste: recarga la pantalla');
        }
      }
      await tx.auditLog.create({
        data: {
          userId: adminUserId,
          action: 'MANUAL_PAYOUT_RECOVERED',
          data: { ...recovery, beneficiaryUserId: beneficiaryId, currency, totalCents, entryIds: ids },
        },
      });
    });

    this.logger.log(`Recuperado ${recovery.batchId}: ${totalCents} ${currency} de ${beneficiaryId} (${input.method})`);
    return { batchId: recovery.batchId, totalCents, currency, entryCount: entries.length };
  }
}
