import { TemplateLocale } from './whatsapp-templates';

export type ChannelKind = 'EMAIL' | 'WHATSAPP';
export type ChannelStatus = 'PENDING' | 'ACTIVE' | 'ERROR' | 'DISABLED';

export interface EmailChannelConfig {
  fromEmail: string;
  fromName?: string | null;
  replyTo?: string | null;
  domain: string;
  domainId?: string | null;
  /** verified | pending | unknown (la clave solo envía y no puede listar dominios) */
  domainStatus: 'verified' | 'pending' | 'unknown';
  /** Si el canal falla, enviar desde LucilaMon en vez de pausar los avisos. */
  fallbackToPlatform: boolean;
  testedAt?: string | null;
}

export interface WhatsAppTemplateState {
  id?: string;
  name: string;
  language: string;
  version: number;
  /** PENDING | APPROVED | REJECTED | PAUSED | DISABLED | IN_APPEAL */
  status: string;
  category?: string | null;
  rejectedReason?: string | null;
  submittedAt?: string | null;
  checkedAt?: string | null;
}

export interface WhatsAppChannelConfig {
  phoneId: string;
  wabaId: string;
  displayPhone: string;
  verifiedName?: string | null;
  qualityRating?: string | null;
  messagingLimitTier?: string | null;
  nameStatus?: string | null;
  platformType?: string | null;
  accountName?: string | null;
  accountReviewStatus?: string | null;
  templates: Partial<Record<TemplateLocale, WhatsAppTemplateState>>;
  /** Cosas que no impiden conectar pero pueden limitar el envío. */
  warnings: string[];
  testSentAt?: string | null;
  testConfirmedAt?: string | null;
}

export const WHATSAPP_APPROVED = 'APPROVED';

/** ¿Tiene alguna plantilla aprobada y utilizable? */
export function approvedTemplates(config: WhatsAppChannelConfig): TemplateLocale[] {
  return (Object.entries(config.templates || {}) as Array<[TemplateLocale, WhatsAppTemplateState | undefined]>)
    .filter(([, state]) => state?.status === WHATSAPP_APPROVED)
    .map(([locale]) => locale);
}

/**
 * ¿Se le puede ofrecer WhatsApp a un corredor? Solo si el canal está activo:
 * plantilla aprobada y mensaje de prueba confirmado por el cliente. Si no, se
 * recogerían teléfonos a los que luego no se puede escribir.
 */
export function whatsappUsable(row: { status: string; config: unknown } | null | undefined): boolean {
  if (!row || row.status !== 'ACTIVE') return false;
  return approvedTemplates(row.config as WhatsAppChannelConfig).length > 0;
}

/** Estado de un canal de WhatsApp según lo que ya se cumplió. */
export function whatsappStatusFor(config: WhatsAppChannelConfig): ChannelStatus {
  return approvedTemplates(config).length > 0 && !!config.testConfirmedAt ? 'ACTIVE' : 'PENDING';
}

/** Elige la plantilla del idioma del corredor; si no hay, la de otro idioma aprobado. */
export function pickTemplate(config: WhatsAppChannelConfig, locale: TemplateLocale): WhatsAppTemplateState | null {
  const approved = approvedTemplates(config);
  if (!approved.length) return null;
  const chosen = approved.includes(locale) ? locale : approved[0];
  return config.templates[chosen] ?? null;
}
