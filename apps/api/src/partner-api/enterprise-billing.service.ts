import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import Stripe from 'stripe';

import { PrismaService } from '../common/services/prisma.service';
import { creditWindow, PHOTO_CREDIT_KIND } from '../billing/usage-window';

/** Importe mínimo que Stripe acepta en una factura. Por debajo se arrastra al mes siguiente. */
const MIN_INVOICE_CENTS = 50;

export type InvoiceOutcome = 'sent' | 'skipped' | 'failed' | 'already_invoiced' | 'no_stripe';

export interface InvoiceResult {
  kind: 'ANNUAL' | 'OVERAGE';
  outcome: InvoiceOutcome;
  amountCents?: number;
  units?: number;
  stripeInvoiceId?: string;
  reason?: string;
}

/**
 * Facturación de los contratos Enterprise.
 *
 * Dos conceptos, ambos con factura enviada al cliente (cobro por tarjeta,
 * transferencia o ACH, a elección de quien paga):
 *
 *   · ANNUAL  — la cuota del contrato, al empezar cada año contractual.
 *   · OVERAGE — las fotografías por encima del cupo anual, cada mes, solo si el
 *               contrato permite el exceso (`allowOverage`) y fija un precio.
 *
 * La tabla `enterprise_invoices` tiene clave única (espacio, tipo, periodo): es
 * lo que impide facturar dos veces si el cron se repite o se lanza a mano. Una
 * fila que quedó sin factura de Stripe (fallo a mitad) se reintenta con la
 * misma clave de idempotencia, así que Stripe tampoco la duplica.
 */
@Injectable()
export class EnterpriseBillingService {
  private readonly logger = new Logger(EnterpriseBillingService.name);
  private readonly stripe: Stripe | null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    const key = this.config.get<string>('STRIPE_SECRET_KEY');
    this.stripe = key ? new Stripe(key, { apiVersion: '2022-11-15' }) : null;
  }

  /** Día 1 de cada mes a las 04:00 (UTC): cuota anual que toque y exceso del mes anterior. */
  @Cron('0 4 1 * *')
  async runMonthly(): Promise<void> {
    const accounts = await this.prisma.enterpriseAccount.findMany({
      where: { status: 'ACTIVE' },
      select: { workspaceId: true },
    });
    let sent = 0;
    for (const { workspaceId } of accounts) {
      const results = await this.invoiceWorkspace(workspaceId).catch(error => {
        this.logger.error(`Facturación de ${workspaceId}: ${error instanceof Error ? error.message : 'error'}`);
        return [] as InvoiceResult[];
      });
      sent += results.filter(r => r.outcome === 'sent').length;
    }
    this.logger.log(`Facturación Enterprise: ${sent} factura(s) enviada(s) a ${accounts.length} cuenta(s)`);
  }

  /** Factura lo que corresponda a un espacio. Es idempotente: se puede lanzar a mano sin riesgo. */
  async invoiceWorkspace(workspaceId: string, now: Date = new Date()): Promise<InvoiceResult[]> {
    const account = await this.prisma.enterpriseAccount.findUnique({ where: { workspaceId } });
    if (!account || account.status !== 'ACTIVE') return [];
    const results: InvoiceResult[] = [];

    const window = creditWindow(account.contractStart, now);

    // 1) Cuota anual: una vez por año contractual.
    if (account.annualPriceCents && account.annualPriceCents > 0 && account.contractStart) {
      results.push(
        await this.issue(workspaceId, account, {
          kind: 'ANNUAL',
          periodKey: window.start.toISOString().slice(0, 10),
          units: 0,
          amountCents: account.annualPriceCents,
          description: `Contrato LucilaMon — año ${window.start.toISOString().slice(0, 10)} a ${window.end.toISOString().slice(0, 10)}`,
        }),
      );
    }

    // 2) Exceso de fotografías, mes vencido.
    if (account.allowOverage && account.annualPhotoLimit != null && account.overagePhotoCents != null) {
      results.push(await this.invoiceOverage(workspaceId, account, window, now));
    }
    return results;
  }

  private async invoiceOverage(workspaceId: string, account: any, window: { start: Date; end: Date }, now: Date): Promise<InvoiceResult> {
    // Hasta el primer día del mes actual: el mes en curso se factura el mes que viene.
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const upTo = monthStart > window.start ? monthStart : window.start;

    const used = await this.prisma.usageLedgerEntry.aggregate({
      where: { workspaceId, kind: PHOTO_CREDIT_KIND, createdAt: { gte: window.start, lt: upTo } },
      _sum: { quantity: true },
    });
    const overageTotal = Math.max(0, Number(used._sum.quantity ?? 0) - account.annualPhotoLimit);

    const billed = await this.prisma.enterpriseInvoice.aggregate({
      where: {
        workspaceId,
        kind: 'OVERAGE',
        periodKey: { startsWith: `${window.start.toISOString().slice(0, 10)}:` },
        status: { in: ['SENT', 'PENDING', 'FAILED'] },
      },
      _sum: { units: true },
    });
    const units = overageTotal - Number(billed._sum.units ?? 0);
    if (units <= 0) return { kind: 'OVERAGE', outcome: 'skipped', reason: 'sin exceso pendiente de facturar' };

    // Se redondea a la baja: lo que sobra de un céntimo queda para el mes siguiente.
    const amountCents = Math.floor(units * Number(account.overagePhotoCents));
    if (amountCents < MIN_INVOICE_CENTS) {
      return { kind: 'OVERAGE', outcome: 'skipped', units, amountCents, reason: 'importe inferior al mínimo; se arrastra' };
    }
    const period = `${upTo.getUTCFullYear()}-${String(upTo.getUTCMonth() + 1).padStart(2, '0')}`;
    return this.issue(workspaceId, account, {
      kind: 'OVERAGE',
      periodKey: `${window.start.toISOString().slice(0, 10)}:${period}`,
      units,
      amountCents,
      description: `Fotografías por encima del cupo anual (${units.toLocaleString('es')} × ${Number(account.overagePhotoCents) / 100} ${account.currency}) hasta ${period}`,
    });
  }

  private async issue(
    workspaceId: string,
    account: { currency: string; invoiceDaysDue: number; billingContactEmail: string | null; businessContactEmail: string | null; legalName: string | null },
    item: { kind: 'ANNUAL' | 'OVERAGE'; periodKey: string; units: number; amountCents: number; description: string },
  ): Promise<InvoiceResult> {
    const base = { kind: item.kind, amountCents: item.amountCents, units: item.units } as const;
    if (!this.stripe) {
      this.logger.warn(`Sin Stripe configurado: no se puede facturar ${item.kind} de ${workspaceId}`);
      return { ...base, outcome: 'no_stripe' };
    }

    // La fila se crea antes que la factura: la clave única es la barrera contra duplicados.
    let row = await this.prisma.enterpriseInvoice.findUnique({
      where: { workspaceId_kind_periodKey: { workspaceId, kind: item.kind, periodKey: item.periodKey } },
    });
    if (row?.status === 'SENT' || row?.stripeInvoiceId) {
      return { ...base, outcome: 'already_invoiced', stripeInvoiceId: row.stripeInvoiceId ?? undefined };
    }
    if (!row) {
      row = await this.prisma.enterpriseInvoice.create({
        data: { workspaceId, kind: item.kind, periodKey: item.periodKey, units: item.units, amountCents: item.amountCents, currency: account.currency },
      });
    }

    try {
      const customerId = await this.ensureCustomer(workspaceId, account);
      const invoice = await this.stripe.invoices.create(
        {
          customer: customerId,
          collection_method: 'send_invoice',
          days_until_due: account.invoiceDaysDue || 30,
          auto_advance: false,
          pending_invoice_items_behavior: 'exclude',
          metadata: { workspaceId, kind: item.kind, periodKey: item.periodKey, enterpriseInvoiceId: row.id },
        },
        { idempotencyKey: `ent-invoice-${row.id}` },
      );
      await this.stripe.invoiceItems.create(
        {
          customer: customerId,
          invoice: invoice.id,
          amount: item.amountCents,
          currency: account.currency.toLowerCase(),
          description: item.description,
        },
        { idempotencyKey: `ent-item-${row.id}` },
      );
      const finalized = await this.stripe.invoices.finalizeInvoice(invoice.id);
      await this.stripe.invoices.sendInvoice(finalized.id);
      await this.prisma.enterpriseInvoice.update({
        where: { id: row.id },
        data: { status: 'SENT', stripeInvoiceId: finalized.id, error: null },
      });
      return { ...base, outcome: 'sent', stripeInvoiceId: finalized.id };
    } catch (error) {
      const message = (error instanceof Error ? error.message : 'error').slice(0, 480);
      await this.prisma.enterpriseInvoice.update({ where: { id: row.id }, data: { status: 'FAILED', error: message } }).catch(() => undefined);
      this.logger.error(`No se pudo facturar ${item.kind} de ${workspaceId}: ${message}`);
      return { ...base, outcome: 'failed', reason: message };
    }
  }

  /** Reutiliza el cliente de Stripe del espacio o lo crea con el correo de facturación del contrato. */
  private async ensureCustomer(
    workspaceId: string,
    account: { billingContactEmail: string | null; businessContactEmail: string | null; legalName: string | null },
  ): Promise<string> {
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { name: true, stripeCustomerId: true, owner: { select: { email: true } } },
    });
    if (workspace?.stripeCustomerId) return workspace.stripeCustomerId;
    const customer = await this.stripe!.customers.create(
      {
        name: account.legalName || workspace?.name,
        email: account.billingContactEmail || account.businessContactEmail || workspace?.owner.email,
        metadata: { workspaceId },
      },
      { idempotencyKey: `ent-customer-${workspaceId}` },
    );
    await this.prisma.workspace.update({ where: { id: workspaceId }, data: { stripeCustomerId: customer.id } });
    return customer.id;
  }
}
