import { aiCallCostUsd, DEFAULT_AI_PRICES, resolveAiPrices } from './ai-pricing';

describe('ai-pricing', () => {
  it('calcula el coste de una llamada con los precios por millón', () => {
    // 501 tokens de entrada y 255 de salida con flash-lite (0,10 / 0,40 por millón)
    const cost = aiCallCostUsd(DEFAULT_AI_PRICES, 'gemini-2.5-flash-lite', 501, 255)!;
    expect(cost).toBeCloseTo((501 * 0.1 + 255 * 0.4) / 1_000_000, 10);
  });

  it('devuelve null si el modelo no tiene precio', () => {
    expect(aiCallCostUsd(DEFAULT_AI_PRICES, 'modelo-desconocido', 100, 100)).toBeNull();
  });

  it('acepta precios propios y conserva los de partida', () => {
    const prices = resolveAiPrices('{"modelo-x":{"inputPerM":2,"outputPerM":8}}');
    expect(prices['modelo-x']).toEqual({ inputPerM: 2, outputPerM: 8 });
    expect(prices['gemini-2.5-pro']).toBeDefined();
  });

  it('ignora un JSON inválido o con precios no numéricos', () => {
    expect(resolveAiPrices('no es json')).toEqual(DEFAULT_AI_PRICES);
    expect(resolveAiPrices('{"x":{"inputPerM":"a","outputPerM":1}}')['x']).toBeUndefined();
  });
});
