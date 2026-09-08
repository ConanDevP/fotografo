export const MIN_PHOTO_PRICE_CENTS = 150;

export type PricingPolicyInput = {
  singlePhoto: number;
  pack5: number;
  pack10: number;
  currency: string;
};

export type PricingPolicyIssue = {
  field: keyof Omit<PricingPolicyInput, 'currency'>;
  minimumCents?: number;
  code: 'PRICE_BELOW_MINIMUM' | 'PACKAGE_NOT_DISCOUNTED' | 'PACKAGE_ORDER_INVALID';
  message: string;
};

/** Reglas comerciales compartidas por eventos, API empresarial y checkout. */
export function pricingPolicyIssue(pricing: PricingPolicyInput): PricingPolicyIssue | null {
  const minimums = {
    singlePhoto: MIN_PHOTO_PRICE_CENTS,
    pack5: MIN_PHOTO_PRICE_CENTS,
    pack10: MIN_PHOTO_PRICE_CENTS,
  } as const;
  for (const field of Object.keys(minimums) as Array<keyof typeof minimums>) {
    if (pricing[field] < minimums[field]) {
      const labels = { singlePhoto: 'La foto individual', pack5: 'El pack de 5', pack10: 'El pack de 10' };
      return {
        field,
        minimumCents: minimums[field],
        code: 'PRICE_BELOW_MINIMUM',
        message: `${labels[field]} debe costar al menos 1.50 ${pricing.currency.toUpperCase()}`,
      };
    }
  }
  if (pricing.pack5 > pricing.singlePhoto * 5) {
    return { field: 'pack5', code: 'PACKAGE_NOT_DISCOUNTED', message: 'El pack de 5 no puede costar más que cinco fotos sueltas' };
  }
  if (pricing.pack10 > pricing.singlePhoto * 10) {
    return { field: 'pack10', code: 'PACKAGE_NOT_DISCOUNTED', message: 'El pack de 10 no puede costar más que diez fotos sueltas' };
  }
  if (pricing.pack10 > pricing.pack5 * 2) {
    return { field: 'pack10', code: 'PACKAGE_ORDER_INVALID', message: 'El pack de 10 debe tener un precio por foto igual o menor que el pack de 5' };
  }
  return null;
}
