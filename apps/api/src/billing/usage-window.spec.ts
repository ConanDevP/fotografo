import { creditWindow } from './usage-window';

describe('creditWindow', () => {
  it('sin contrato usa una ventana móvil de 365 días', () => {
    const now = new Date('2026-10-28T12:00:00Z');
    const { start, end } = creditWindow(null, now);
    expect(end.getTime()).toBe(now.getTime());
    expect(Math.round((now.getTime() - start.getTime()) / 86_400_000)).toBe(365);
  });

  it('con contrato, el año empieza en el último aniversario', () => {
    const start = new Date('2025-03-15T00:00:00Z');
    const { start: s, end: e } = creditWindow(start, new Date('2026-10-28T00:00:00Z'));
    expect(s.toISOString()).toBe('2026-03-15T00:00:00.000Z');
    expect(e.toISOString()).toBe('2027-03-15T00:00:00.000Z');
  });

  it('antes del primer aniversario la ventana es el primer año', () => {
    const start = new Date('2026-09-01T00:00:00Z');
    const { start: s, end: e } = creditWindow(start, new Date('2026-10-28T00:00:00Z'));
    expect(s.toISOString()).toBe(start.toISOString());
    expect(e.toISOString()).toBe('2027-09-01T00:00:00.000Z');
  });

  it('el día exacto del aniversario ya cuenta como año nuevo', () => {
    const { start: s } = creditWindow(new Date('2025-10-28T00:00:00Z'), new Date('2026-10-28T00:00:00Z'));
    expect(s.toISOString()).toBe('2026-10-28T00:00:00.000Z');
  });
});
