import { createHmac, timingSafeEqual } from 'crypto';

/** Versión del texto de consentimiento que se muestra en /r/{code}. Súbela al cambiar el texto. */
export const REGISTRATION_CONSENT_VERSION = 'v1-2026-11';

/** Los avisos de un mismo corredor se juntan en una ventana de este tamaño. */
export const DIGEST_WINDOW_MS = 10 * 60 * 1000;

/** El registro por QR cierra tantos días después de la fecha del evento. */
export const REGISTRATION_WINDOW_DAYS = 30;

/** Los registros se borran tantos días después del evento. */
export const REGISTRATION_RETENTION_DAYS = 180;

/**
 * Enlace de baja: `id.firma`. La firma es un HMAC del id, así que el enlace no
 * caduca ni requiere guardar nada, y nadie puede dar de baja a otro adivinando ids.
 */
export function signUnsubscribeToken(subscriptionId: string, secret: string): string {
  const signature = createHmac('sha256', secret).update(`unsub:${subscriptionId}`).digest('base64url');
  return `${subscriptionId}.${signature}`;
}

export function verifyUnsubscribeToken(token: string, secret: string): string | null {
  const separator = token.indexOf('.');
  if (separator < 1) return null;
  const id = token.slice(0, separator);
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const expected = Buffer.from(signUnsubscribeToken(id, secret));
  const received = Buffer.from(token);
  if (expected.length !== received.length) return null;
  return timingSafeEqual(expected, received) ? id : null;
}

/** Cubeta de 10 minutos: dos fotos de la misma ventana comparten un solo aviso. */
export function digestJobId(subscriptionId: string, now = Date.now()): string {
  return `digest-${subscriptionId}-${Math.floor(now / DIGEST_WINDOW_MS)}`;
}
