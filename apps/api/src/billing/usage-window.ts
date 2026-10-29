/** Tipo de crédito que consume una fotografía procesada. */
export const PHOTO_CREDIT_KIND = 'PHOTO_PROCESSED';

const DAY_MS = 24 * 60 * 60 * 1000;

function addYearsUTC(date: Date, years: number): Date {
  const copy = new Date(date.getTime());
  copy.setUTCFullYear(copy.getUTCFullYear() + years);
  return copy;
}

/**
 * Ventana de un año sobre la que se mide el cupo anual de fotografías.
 *
 * Con contrato, el año contractual empieza en el último aniversario de su
 * fecha de inicio: así el cupo se renueva el día en que se renueva el contrato
 * y no el 1 de enero. Sin fecha de inicio (cuentas de prueba) se usa una
 * ventana móvil de 365 días.
 */
export function creditWindow(contractStart: Date | null | undefined, now: Date = new Date()): { start: Date; end: Date } {
  if (!contractStart) {
    return { start: new Date(now.getTime() - 365 * DAY_MS), end: now };
  }
  let years = now.getUTCFullYear() - contractStart.getUTCFullYear();
  let start = addYearsUTC(contractStart, years);
  if (start.getTime() > now.getTime()) {
    years -= 1;
    start = addYearsUTC(contractStart, years);
  }
  if (start.getTime() < contractStart.getTime()) start = contractStart;
  return { start, end: addYearsUTC(start, 1) };
}
