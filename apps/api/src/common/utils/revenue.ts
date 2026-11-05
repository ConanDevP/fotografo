import { Prisma } from '@prisma/client';

/**
 * Reglas comunes para sumar dinero.
 *
 * Tres cosas que antes estaban repetidas (y mal) en cada panel:
 *  - Nunca se suman monedas distintas: un evento en lempiras y otro en dólares
 *    no dan un total.
 *  - El periodo de una venta es el de su pago, no el de la creación del pedido.
 *  - Un pedido reembolsado o en disputa no cuenta como ingreso.
 */

/** Asientos que forman el ingreso de una venta. */
export const REVENUE_LEDGER_TYPES = [
  'GROSS_SALE',
  'PROCESSOR_FEE',
  'PLATFORM_FEE',
  'ORGANIZER_COMMISSION',
  'PHOTOGRAPHER_EARNING',
] as const;

/** Movimientos que existen precisamente porque una venta dejó de contar. */
export const ADJUSTMENT_LEDGER_TYPES = ['REFUND', 'DISPUTE', 'DISPUTE_FEE'] as const;

export type MoneyByCurrency = Record<string, number>;

export interface PrimaryMoney {
  /** Moneda con más volumen. Es la que se muestra en las cifras de siempre. */
  currency: string;
  cents: number;
  /** Importe de cada moneda, para quien necesite el desglose. */
  byCurrency: MoneyByCurrency;
  /** Hay más de una moneda con importe: la cifra principal no es el total. */
  mixedCurrencies: boolean;
}

export function addMoney(into: MoneyByCurrency, currency: string | null | undefined, cents: number | null | undefined) {
  const key = (currency || 'USD').toUpperCase();
  into[key] = (into[key] ?? 0) + (cents ?? 0);
}

/**
 * Reduce un desglose por moneda a la cifra principal. Las apps existentes
 * esperaban un solo número; así lo siguen recibiendo, pero ya no es la suma de
 * monedas distintas.
 */
export function primaryMoney(byCurrency: MoneyByCurrency, fallbackCurrency = 'USD'): PrimaryMoney {
  const entries = Object.entries(byCurrency).filter(([, cents]) => cents !== 0);
  if (entries.length === 0) {
    return { currency: fallbackCurrency, cents: 0, byCurrency: {}, mixedCurrencies: false };
  }
  entries.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]) || a[0].localeCompare(b[0]));
  const [currency, cents] = entries[0];
  return {
    currency,
    cents,
    byCurrency: Object.fromEntries(entries),
    mixedCurrencies: entries.length > 1,
  };
}

/** Suma de las filas de un `groupBy` por moneda. */
export function sumRowsByCurrency<T extends { currency: string }>(
  rows: T[],
  pick: (row: T) => number | null | undefined,
): MoneyByCurrency {
  const out: MoneyByCurrency = {};
  for (const row of rows) addMoney(out, row.currency, pick(row));
  return out;
}

/**
 * Pedidos pagados dentro de un rango, por fecha de pago.
 *
 * Los pedidos anteriores a que existiera `paidAt` (o cobrados por un camino
 * que no lo guardaba) caen a su fecha de creación en lugar de desaparecer.
 */
export function paidInRange(start?: Date, end?: Date): Prisma.OrderWhereInput {
  if (!start && !end) return { status: 'PAID' };
  const range = { ...(start ? { gte: start } : {}), ...(end ? { lte: end } : {}) };
  return {
    status: 'PAID',
    OR: [{ paidAt: range }, { paidAt: null, createdAt: range }],
  };
}

/**
 * Asientos que cuentan como ingreso: los de ventas que siguen pagadas, más los
 * movimientos de ajuste (reembolsos, disputas) que se muestran aparte.
 *
 * Se filtra por el estado del PEDIDO y no por el del asiento: un reembolso
 * hecho desde el panel de Stripe, uno hecho aquí o una disputa perdida dejan
 * los asientos en estados distintos, pero los tres dejan el pedido sin pagar.
 */
export function countingLedgerWhere(base: Prisma.LedgerEntryWhereInput): Prisma.LedgerEntryWhereInput {
  return {
    AND: [
      base,
      {
        OR: [
          { type: { in: [...REVENUE_LEDGER_TYPES] }, order: { status: 'PAID' } },
          { type: { in: [...ADJUSTMENT_LEDGER_TYPES] } },
        ],
      },
    ],
  };
}

/** Total por tipo y moneda a partir de un `groupBy(['currency','type'])`. */
export function ledgerByTypeAndCurrency(
  rows: Array<{ currency: string; type: string; _sum: { amountCents: number | null } }>,
): Record<string, MoneyByCurrency> {
  const out: Record<string, MoneyByCurrency> = {};
  for (const row of rows) {
    out[row.type] ??= {};
    addMoney(out[row.type], row.currency, row._sum.amountCents);
  }
  return out;
}
