import { bibMatchesRules } from './bib-rules';

describe('bibMatchesRules', () => {
  it('sin reglas acepta cualquier dorsal', () => {
    expect(bibMatchesRules('99999', null)).toBe(true);
    expect(bibMatchesRules('1', undefined)).toBe(true);
  });

  it('respeta largo, rango y lista cerrada', () => {
    expect(bibMatchesRules('12', { minLen: 3 })).toBe(false);
    expect(bibMatchesRules('12345', { maxLen: 4 })).toBe(false);
    expect(bibMatchesRules('50', { range: [1, 40] })).toBe(false);
    expect(bibMatchesRules('40', { range: [1, 40] })).toBe(true);
    expect(bibMatchesRules('7', { whitelist: ['7', '8'] })).toBe(true);
    expect(bibMatchesRules('9', { whitelist: ['7', '8'] })).toBe(false);
  });

  it('una expresión regular rota no cierra el registro', () => {
    expect(bibMatchesRules('12', { regex: '(' })).toBe(true);
    expect(bibMatchesRules('12', { regex: '^1' })).toBe(true);
    expect(bibMatchesRules('22', { regex: '^1' })).toBe(false);
  });
});
