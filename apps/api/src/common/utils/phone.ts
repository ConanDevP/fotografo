import { CountryCode, isSupportedCountry, parsePhoneNumberFromString } from 'libphonenumber-js';

export interface NormalizedPhone {
  /** Formato E.164, por ejemplo +5215512345678. */
  e164: string;
  /** País del número (ISO 3166-1 alfa-2). */
  country: string;
}

/**
 * Valida un teléfono y lo deja en E.164. Acepta el número con prefijo (`+52…`) o
 * sin él si se da el país. Devuelve `null` si no es un número real.
 */
export function normalizePhone(raw: string, defaultCountry?: string | null): NormalizedPhone | null {
  const country = defaultCountry && isSupportedCountry(defaultCountry.toUpperCase())
    ? (defaultCountry.toUpperCase() as CountryCode)
    : undefined;
  const parsed = parsePhoneNumberFromString(raw.trim(), country);
  if (!parsed || !parsed.isValid() || !parsed.country) return null;
  return { e164: parsed.number, country: parsed.country };
}
