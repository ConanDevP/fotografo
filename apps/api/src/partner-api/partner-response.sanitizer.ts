import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

/**
 * Campos que existen en la base de datos pero no forman parte del contrato público:
 * facturación y pasarela de pago, claves de almacenamiento, hashes y consumo del proveedor
 * de IA. Se quitan de las respuestas y de los webhooks para no exponer la infraestructura
 * ni los datos comerciales de LucilaMon.
 */
export const INTERNAL_FIELDS: ReadonlySet<string> = new Set([
  // facturación y pasarela de pago
  'stripeCustomerId', 'defaultPaymentMethodId', 'pendingShareChargeCents', 'platformFeePercent',
  'shareChargeCents', 'shareChargePhotos', 'shareChargedAt', 'shareChargeIntentId',
  // proveedores de infraestructura
  'provider', 'providerId',
  // almacenamiento
  'cloudinaryId', 'originalUrl', 'contentHash',
  // hashes y secretos
  'tokenHash', 'secretHash', 'passwordHash', 'secretEncrypted',
  // consumo del proveedor de IA
  'promptTokens', 'candidatesTokens', 'totalTokens', 'geminiImageWidth', 'geminiImageHeight',
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Copia profunda sin los campos internos. Fechas, Decimal y otros objetos con `toJSON` se conservan tal cual. */
export function stripInternalFields<T>(value: T): T {
  if (Array.isArray(value)) return value.map(item => stripInternalFields(item)) as unknown as T;
  if (!isPlainObject(value)) return value;
  const clean: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!INTERNAL_FIELDS.has(key)) clean[key] = stripInternalFields(item);
  }
  return clean as T;
}

@Injectable()
export class PartnerResponseInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      map(body => (isPlainObject(body) && 'data' in body ? { ...body, data: stripInternalFields(body.data) } : body)),
    );
  }
}
