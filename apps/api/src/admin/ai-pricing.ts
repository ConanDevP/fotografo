export interface ModelPrice {
  /** USD por millón de tokens de entrada. */
  inputPerM: number;
  /** USD por millón de tokens de salida (incluye el razonamiento interno del modelo). */
  outputPerM: number;
}

/**
 * Precios de partida. Son una referencia, no una verdad: cámbialos con
 * `AI_PRICING_JSON` cuando el proveedor actualice tarifas, por ejemplo
 * `{"gemini-2.5-pro":{"inputPerM":1.25,"outputPerM":10}}`.
 */
export const DEFAULT_AI_PRICES: Record<string, ModelPrice> = {
  'gemini-2.5-flash-lite': { inputPerM: 0.1, outputPerM: 0.4 },
  'gemini-2.5-pro': { inputPerM: 1.25, outputPerM: 10 },
};

export function resolveAiPrices(override?: string | null): Record<string, ModelPrice> {
  if (!override) return DEFAULT_AI_PRICES;
  try {
    const parsed = JSON.parse(override) as Record<string, ModelPrice>;
    const valid = Object.entries(parsed).filter(
      ([, price]) => Number.isFinite(price?.inputPerM) && Number.isFinite(price?.outputPerM),
    );
    return { ...DEFAULT_AI_PRICES, ...Object.fromEntries(valid) };
  } catch {
    return DEFAULT_AI_PRICES;
  }
}

/** Coste de una llamada, o `null` si el modelo no tiene precio configurado. */
export function aiCallCostUsd(
  prices: Record<string, ModelPrice>,
  model: string,
  promptTokens: number,
  outputTokens: number,
): number | null {
  const price = prices[model];
  if (!price) return null;
  return (promptTokens * price.inputPerM + outputTokens * price.outputPerM) / 1_000_000;
}
