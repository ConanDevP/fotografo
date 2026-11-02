/**
 * Qué significa un error del proveedor y de quién es el problema.
 *
 * Todo aviso falla por una razón concreta. Lo importante para el cliente es
 * saber si es de su cuenta (saldo, dominio, plantilla), del destinatario o algo
 * pasajero, y qué hacer. Estos textos se muestran tal cual en el panel.
 */
export type IssueScope =
  /** La cuenta del cliente no puede enviar: se pausa el canal hasta que lo arregle. */
  | 'ACCOUNT'
  /** La plantilla de WhatsApp no sirve (rechazada, pausada, parámetros): se pausa hasta corregirla. */
  | 'TEMPLATE'
  /** Solo ese destinatario falla (número sin WhatsApp, correo inválido): se descarta ese aviso. */
  | 'RECIPIENT'
  /** El proveedor limita el ritmo o el volumen: se reintenta más tarde. */
  | 'LIMIT'
  /** Caída o error pasajero: se reintenta enseguida. */
  | 'TRANSIENT';

export interface ClassifiedError {
  scope: IssueScope;
  /** Código corto y estable, apto para guardar y para deduplicar alertas. */
  code: string;
  /** Qué pasó, en lenguaje llano. */
  message: string;
  /** Qué debe hacer el cliente (solo si le corresponde a él). */
  action?: string;
  helpUrl?: string;
  /** Cuánto esperar antes de reintentar un LIMIT. */
  retryAfterMs?: number;
  /** El proveedor respondió con esto (recortado), para soporte. */
  raw?: string;
}

export class ChannelSendError extends Error {
  constructor(readonly detail: ClassifiedError) {
    super(`${detail.code}: ${detail.message}`);
    this.name = 'ChannelSendError';
  }
}

const MIN = 60_000;
const RESEND_DOMAINS = 'https://resend.com/domains';
const RESEND_KEYS = 'https://resend.com/api-keys';
const RESEND_BILLING = 'https://resend.com/settings/billing';
const META_BILLING = 'https://business.facebook.com/billing_hub/payment_methods';
const META_WHATSAPP = 'https://business.facebook.com/latest/whatsapp_manager/overview';
const META_ERRORS = 'https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes';

const clip = (value: unknown) => String(value ?? '').replace(/\s+/g, ' ').slice(0, 300);

// ── Resend ──────────────────────────────────────────────────────────────────

export function classifyResendError(status: number | undefined, body: any): ClassifiedError {
  const name: string = body?.name || '';
  const message: string = body?.message || '';
  const raw = clip(`${status ?? ''} ${name} ${message}`);

  if (/domain is not verified|verify a domain|testing emails to your own/i.test(message)) {
    return {
      scope: 'ACCOUNT', code: 'EMAIL_DOMAIN_NOT_VERIFIED', raw,
      message: 'Resend no deja enviar desde ese remitente porque su dominio no está verificado en tu cuenta de Resend.',
      action: 'Entra a Resend → Domains, añade los registros DNS que te muestra (SPF y DKIM) y espera a que diga «Verified».',
      helpUrl: RESEND_DOMAINS,
    };
  }
  switch (name) {
    case 'missing_api_key':
    case 'invalid_api_key':
    case 'restricted_api_key':
    case 'invalid_access':
    case 'invalid_scope':
      if (name === 'restricted_api_key' || name === 'invalid_scope') {
        return {
          scope: 'ACCOUNT', code: 'EMAIL_KEY_RESTRICTED', raw,
          message: 'La clave de Resend que conectaste no tiene permiso para enviar correos.',
          action: 'Crea una clave nueva con permiso «Full access» o «Sending access» y vuelve a conectarla.',
          helpUrl: RESEND_KEYS,
        };
      }
      return {
        scope: 'ACCOUNT', code: 'EMAIL_KEY_INVALID', raw,
        message: 'Resend no reconoce la clave que conectaste (la borraron, la cambiaron o está mal copiada).',
        action: 'Crea una clave nueva en Resend y vuélvela a pegar aquí.',
        helpUrl: RESEND_KEYS,
      };
    case 'daily_quota_exceeded':
      return {
        scope: 'LIMIT', code: 'EMAIL_DAILY_QUOTA', raw, retryAfterMs: 60 * MIN,
        message: 'Tu cuenta de Resend llegó a su límite diario de correos (el plan gratuito permite 100 al día).',
        action: 'Los avisos pendientes salen solos cuando Resend renueve el cupo, o sube tu plan en Resend para enviar más.',
        helpUrl: RESEND_BILLING,
      };
    case 'monthly_quota_exceeded':
      return {
        scope: 'LIMIT', code: 'EMAIL_MONTHLY_QUOTA', raw, retryAfterMs: 6 * 60 * MIN,
        message: 'Tu cuenta de Resend llegó a su límite mensual de correos.',
        action: 'Sube tu plan en Resend; los avisos pendientes saldrán después.',
        helpUrl: RESEND_BILLING,
      };
    case 'rate_limit_exceeded':
      return { scope: 'LIMIT', code: 'EMAIL_RATE_LIMIT', raw, retryAfterMs: 2 * MIN, message: 'Resend pidió ir más despacio: se reintenta en unos minutos.' };
    case 'invalid_from_address':
      return {
        scope: 'ACCOUNT', code: 'EMAIL_FROM_INVALID', raw,
        message: 'Resend no acepta el remitente configurado.',
        action: 'Usa un formato como «fotos@tudominio.com» con un dominio verificado en Resend.',
        helpUrl: RESEND_DOMAINS,
      };
    case 'validation_error':
    case 'missing_required_field':
      if (/\bto\b/i.test(message)) {
        return { scope: 'RECIPIENT', code: 'EMAIL_RECIPIENT_INVALID', raw, message: 'El correo del corredor no es válido: se omitió este aviso.' };
      }
      return { scope: 'TEMPLATE', code: 'EMAIL_VALIDATION', raw, message: `Resend rechazó el mensaje: ${clip(message) || 'datos no válidos'}.` };
    default:
  }
  if (status === 401) {
    return { scope: 'ACCOUNT', code: 'EMAIL_KEY_INVALID', raw, message: 'Resend no reconoce la clave que conectaste.', action: 'Crea una clave nueva en Resend y vuélvela a pegar aquí.', helpUrl: RESEND_KEYS };
  }
  if (status === 429) return { scope: 'LIMIT', code: 'EMAIL_RATE_LIMIT', raw, retryAfterMs: 2 * MIN, message: 'Resend pidió ir más despacio: se reintenta en unos minutos.' };
  if (status === undefined || status >= 500) {
    return { scope: 'TRANSIENT', code: 'EMAIL_PROVIDER_DOWN', raw, message: 'Resend no respondió. Se reintenta automáticamente.' };
  }
  return { scope: 'TRANSIENT', code: 'EMAIL_UNKNOWN', raw, message: 'Resend devolvió un error que no reconocemos. Se reintenta automáticamente.' };
}

// ── WhatsApp (Meta Cloud API) ───────────────────────────────────────────────

export function classifyWhatsAppError(status: number | undefined, body: any): ClassifiedError {
  const error = body?.error ?? {};
  const code: number | undefined = typeof error.code === 'number' ? error.code : undefined;
  const subcode: number | undefined = typeof error.error_subcode === 'number' ? error.error_subcode : undefined;
  const detail = error.error_data?.details || error.message || '';
  const raw = clip(`${status ?? ''} #${code ?? ''}${subcode ? `/${subcode}` : ''} ${detail}`);

  const account = (c: string, message: string, action?: string, helpUrl = META_WHATSAPP): ClassifiedError =>
    ({ scope: 'ACCOUNT', code: c, message, action, helpUrl, raw });
  const template = (c: string, message: string, action?: string): ClassifiedError =>
    ({ scope: 'TEMPLATE', code: c, message, action, helpUrl: META_WHATSAPP, raw });
  const limit = (c: string, message: string, retryAfterMs: number, action?: string): ClassifiedError =>
    ({ scope: 'LIMIT', code: c, message, action, retryAfterMs, helpUrl: META_ERRORS, raw });
  const recipient = (c: string, message: string): ClassifiedError => ({ scope: 'RECIPIENT', code: c, message, raw });

  switch (code) {
    case 190:
    case 102:
    case 463:
    case 467:
      return account('WA_TOKEN_INVALID', 'Meta rechaza el token de acceso: venció, fue revocado o está mal copiado. Los tokens temporales caducan a las 24 horas.',
        'Crea un token permanente (usuario del sistema con permiso whatsapp_business_messaging) y pégalo de nuevo aquí.', 'https://business.facebook.com/settings/system-users');
    case 10:
    case 200:
    case 299:
      return account('WA_PERMISSION', 'El token no tiene permiso para enviar mensajes de WhatsApp en esa cuenta.',
        'Asigna la cuenta de WhatsApp al usuario del sistema con control total y el permiso whatsapp_business_messaging, y genera el token otra vez.', 'https://business.facebook.com/settings/system-users');
    case 131042:
      return account('WA_BILLING', 'Meta no puede cobrar los mensajes: tu cuenta de WhatsApp Business no tiene un método de pago válido o está sin fondos.',
        'En Meta Business Suite → Facturación y pagos, añade o corrige el método de pago de tu cuenta de WhatsApp. Esto lo controla Meta, no LucilaMon.', META_BILLING);
    case 131031:
      return account('WA_ACCOUNT_LOCKED', 'Meta bloqueó tu cuenta de WhatsApp Business.', 'Revisa el aviso en WhatsApp Manager y sigue el proceso de Meta para desbloquearla.');
    case 368:
      return account('WA_POLICY_BLOCK', 'Meta restringió temporalmente tu cuenta por una infracción de sus políticas.', 'Revisa los avisos de calidad de la cuenta en WhatsApp Manager.');
    case 131030:
      return account('WA_TEST_NUMBER', 'Tu número es un número de prueba de Meta: solo puede escribir a teléfonos que agregues manualmente a su lista.',
        'Registra un número real de WhatsApp Business (no el de prueba) para escribir a cualquier corredor.');
    case 131037:
      return account('WA_DISPLAY_NAME', 'Meta aún tiene que aprobar el nombre de tu perfil de WhatsApp Business.', 'Revisa el nombre visible en WhatsApp Manager.');
    case 131045:
    case 133010:
    case 133005:
    case 133006:
      return account('WA_NUMBER_NOT_REGISTERED', 'El número de WhatsApp no está registrado o verificado en la Cloud API.',
        'En WhatsApp Manager completa el registro y la verificación del número.');
    case 131026:
      return recipient('WA_UNDELIVERABLE', 'Ese teléfono no recibe mensajes de WhatsApp o no aceptó las condiciones: se omitió este aviso.');
    case 131021:
      return recipient('WA_SAME_NUMBER', 'El destinatario es el mismo número desde el que se envía: se omitió este aviso.');
    case 131047:
    case 131049:
    case 130472:
      return recipient('WA_NOT_DELIVERED', 'Meta decidió no entregar este mensaje a ese teléfono (límite de calidad por destinatario): se omitió este aviso.');
    case 131048:
    case 131056:
      return limit('WA_RATE_LIMIT', 'Meta limitó temporalmente el ritmo de envío de tu número.', 15 * MIN);
    case 130429:
    case 80007:
    case 4:
    case 17:
    case 32:
    case 613:
      return limit('WA_RATE_LIMIT', 'Meta pidió ir más despacio: demasiados mensajes en poco tiempo.', 5 * MIN);
    case 131009:
      return template('WA_PARAM_INVALID', 'Meta rechazó un valor de la plantilla (por ejemplo, el nombre del evento).', 'Revisa que el nombre del evento no lleve saltos de línea ni caracteres raros.');
    case 132000:
    case 132012:
      return template('WA_TEMPLATE_PARAMS', 'La plantilla aprobada en tu cuenta no tiene el formato que espera LucilaMon (4 variables en el cuerpo).',
        'Desde LucilaMon usa «Enviar plantillas a revisión» para crear la correcta; no la edites en Meta.');
    case 132001:
      return template('WA_TEMPLATE_MISSING', 'La plantilla no existe en tu cuenta de WhatsApp (la borraron o es de otro idioma).', 'Vuelve a enviar las plantillas a revisión desde LucilaMon.');
    case 132005:
      return template('WA_TEXT_TOO_LONG', 'El texto traducido de la plantilla es demasiado largo.', 'Acorta el nombre del evento.');
    case 132007:
      return template('WA_TEMPLATE_POLICY', 'Meta considera que la plantilla infringe sus políticas.', 'Envía una versión nueva de la plantilla a revisión.');
    case 132015:
      return template('WA_TEMPLATE_PAUSED', 'Meta pausó tu plantilla por baja calidad (muchos usuarios la reportaron o la bloquearon).', 'Revisa la calidad en WhatsApp Manager o envía una versión nueva.');
    case 132016:
      return template('WA_TEMPLATE_DISABLED', 'Meta desactivó tu plantilla por baja calidad sostenida.', 'Envía una versión nueva de la plantilla a revisión.');
    case 1:
    case 2:
    case 131000:
    case 131016:
    case 131057:
    case 133004:
    case 135000:
      return { scope: 'TRANSIENT', code: 'WA_PROVIDER_DOWN', raw, message: 'WhatsApp no respondió bien. Se reintenta automáticamente.' };
    case 100:
      if (subcode === 33 || /does not exist|missing permissions|cannot be loaded/i.test(String(error.message))) {
        return account('WA_ID_NOT_FOUND', 'Meta no encuentra ese ID, o el token no tiene acceso a él.',
          'Comprueba el ID del número y el ID de la cuenta de WhatsApp Business en WhatsApp Manager → Herramientas de API.');
      }
      return template('WA_BAD_REQUEST', `Meta rechazó la solicitud: ${clip(detail) || 'datos no válidos'}.`);
    default:
  }
  if (status === 429) return limit('WA_RATE_LIMIT', 'Meta pidió ir más despacio.', 5 * MIN);
  if (status === 401 || status === 403) return account('WA_TOKEN_INVALID', 'Meta rechaza el acceso con ese token.', 'Genera un token nuevo y pégalo de nuevo aquí.');
  if (status === undefined || status >= 500) return { scope: 'TRANSIENT', code: 'WA_PROVIDER_DOWN', raw, message: 'WhatsApp no respondió. Se reintenta automáticamente.' };
  return { scope: 'TRANSIENT', code: 'WA_UNKNOWN', raw, message: 'Meta devolvió un error que no reconocemos. Se reintenta automáticamente.' };
}

/** Un fallo de red (sin respuesta) es siempre pasajero. */
export function networkError(channel: 'EMAIL' | 'WHATSAPP', cause: unknown): ClassifiedError {
  return {
    scope: 'TRANSIENT',
    code: channel === 'EMAIL' ? 'EMAIL_PROVIDER_DOWN' : 'WA_PROVIDER_DOWN',
    message: `No se pudo contactar con ${channel === 'EMAIL' ? 'Resend' : 'Meta'}. Se reintenta automáticamente.`,
    raw: clip(cause instanceof Error ? cause.message : cause),
  };
}
