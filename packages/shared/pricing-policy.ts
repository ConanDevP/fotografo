export const MIN_PHOTO_PRICE_CENTS = 150;
export const MIN_ALL_PHOTOS_PRICE_CENTS = 1500;

export type PricingPolicyInput = {
  singlePhoto: number;
  pack5: number;
  pack10: number;
  allPhotos: number;
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
    pack5: MIN_PHOTO_PRICE_CENTS * 5,
    pack10: MIN_PHOTO_PRICE_CENTS * 10,
    allPhotos: MIN_ALL_PHOTOS_PRICE_CENTS,
  } as const;
  for (const field of Object.keys(minimums) as Array<keyof typeof minimums>) {
    if (pricing[field] < minimums[field]) {
      return { field, minimumCents: minimums[field], code: 'PRICE_BELOW_MINIMUM', message: `${field} debe ser al menos ${minimums[field]} centavos` };
    }
  }
  if (pricing.pack5 > pricing.singlePhoto * 5) {
    return { field: 'pack5', code: 'PACKAGE_NOT_DISCOUNTED', message: 'El pack de 5 no puede costar mas que cinco fotos sueltas' };
  }
  if (pricing.pack10 > pricing.singlePhoto * 10) {
    return { field: 'pack10', code: 'PACKAGE_NOT_DISCOUNTED', message: 'El pack de 10 no puede costar mas que diez fotos sueltas' };
  }
  if (pricing.pack10 > pricing.pack5 * 2) {
    return { field: 'pack10', code: 'PACKAGE_ORDER_INVALID', message: 'El pack de 10 debe tener un precio por foto igual o menor que el pack de 5' };
  }
  if (pricing.allPhotos < pricing.pack10) {
    return { field: 'allPhotos', code: 'PACKAGE_ORDER_INVALID', message: 'Todas las fotos no puede costar menos que el pack de 10' };
  }
  return null;
}
