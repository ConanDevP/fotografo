import type { BibRules } from '@shared/types';

/** ¿Es un dorsal posible según las reglas del evento? Sin reglas, cualquiera. */
export function bibMatchesRules(bib: string, rules?: BibRules | null): boolean {
  if (!rules) return true;
  if (rules.minLen && bib.length < rules.minLen) return false;
  if (rules.maxLen && bib.length > rules.maxLen) return false;
  if (rules.range) {
    const value = Number(bib);
    if (value < rules.range[0] || value > rules.range[1]) return false;
  }
  if (rules.whitelist?.length && !rules.whitelist.map(String).includes(bib)) return false;
  if (rules.regex) {
    try {
      if (!new RegExp(rules.regex).test(bib)) return false;
    } catch {
      // Una expresión mal escrita por el organizador no debe cerrar el registro.
    }
  }
  return true;
}
