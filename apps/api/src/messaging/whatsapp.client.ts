import { ChannelSendError, classifyWhatsAppError, networkError } from './delivery-errors';

export interface WhatsAppPhone {
  id: string;
  displayPhoneNumber: string;
  verifiedName: string | null;
  /** GREEN | YELLOW | RED | UNKNOWN */
  qualityRating: string | null;
  /** TIER_250, TIER_1K, TIER_10K, TIER_100K, TIER_UNLIMITED */
  messagingLimitTier: string | null;
  /** APPROVED | PENDING_REVIEW | DECLINED | NONE ... */
  nameStatus: string | null;
  /** CLOUD_API | ON_PREMISE | NOT_APPLICABLE */
  platformType: string | null;
  /** CONNECTED | PENDING | FLAGGED | RESTRICTED ... */
  status: string | null;
}

export interface WhatsAppTemplateInfo {
  id: string;
  name: string;
  language: string;
  /** APPROVED | PENDING | REJECTED | PAUSED | DISABLED | IN_APPEAL ... */
  status: string;
  /** UTILITY | MARKETING | AUTHENTICATION */
  category: string;
  rejectedReason: string | null;
}

/** Configurable solo para pruebas con un proveedor simulado. */
const GRAPH_BASE = process.env.WHATSAPP_GRAPH_BASE || 'https://graph.facebook.com';

const PHONE_FIELDS = 'id,display_phone_number,verified_name,quality_rating,messaging_limit_tier,name_status,platform_type,status';
const PHONE_FIELDS_BASIC = 'id,display_phone_number,verified_name,quality_rating';

/** Cliente mínimo de la WhatsApp Cloud API con las credenciales del propio cliente. */
export class WhatsAppClient {
  constructor(
    private readonly token: string,
    private readonly apiVersion = 'v21.0',
    private readonly timeoutMs = 20_000,
  ) {}

  private async graph(method: 'GET' | 'POST', path: string, body?: unknown): Promise<any> {
    let response: Response;
    try {
      response = await fetch(`${GRAPH_BASE}/${this.apiVersion}/${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new ChannelSendError(networkError('WHATSAPP', error));
    }
    const json = await response.json().catch(() => null);
    if (!response.ok) throw new ChannelSendError(classifyWhatsAppError(response.status, json));
    return json;
  }

  async getAccount(wabaId: string): Promise<{ id: string; name: string | null; currency: string | null; reviewStatus: string | null }> {
    const base = await this.graph('GET', `${encodeURIComponent(wabaId)}?fields=id,name,currency`);
    // Estado de revisión de la cuenta: no todos los tokens lo pueden leer, y no es imprescindible.
    const review = await this.graph('GET', `${encodeURIComponent(wabaId)}?fields=account_review_status`).catch(() => null);
    return {
      id: base.id,
      name: base.name ?? null,
      currency: base.currency ?? null,
      reviewStatus: review?.account_review_status ?? null,
    };
  }

  async listPhones(wabaId: string): Promise<WhatsAppPhone[]> {
    const read = (fields: string) => this.graph('GET', `${encodeURIComponent(wabaId)}/phone_numbers?fields=${fields}&limit=100`);
    let json: any;
    try {
      json = await read(PHONE_FIELDS);
    } catch (error) {
      // Algunas versiones no exponen todos los campos: se reintenta con los básicos.
      if (error instanceof ChannelSendError && error.detail.code === 'WA_BAD_REQUEST') json = await read(PHONE_FIELDS_BASIC);
      else throw error;
    }
    return (Array.isArray(json?.data) ? json.data : []).map((item: any) => ({
      id: String(item.id),
      displayPhoneNumber: item.display_phone_number ?? '',
      verifiedName: item.verified_name ?? null,
      qualityRating: item.quality_rating ?? null,
      messagingLimitTier: item.messaging_limit_tier ?? null,
      nameStatus: item.name_status ?? null,
      platformType: item.platform_type ?? null,
      status: item.status ?? null,
    }));
  }

  async listTemplates(wabaId: string, namePrefix: string): Promise<WhatsAppTemplateInfo[]> {
    const json = await this.graph(
      'GET',
      `${encodeURIComponent(wabaId)}/message_templates?fields=id,name,language,status,category,rejected_reason&limit=200`,
    );
    return (Array.isArray(json?.data) ? json.data : [])
      .filter((item: any) => typeof item.name === 'string' && item.name.startsWith(namePrefix))
      .map((item: any) => ({
        id: String(item.id),
        name: item.name,
        language: item.language,
        status: item.status,
        category: item.category,
        rejectedReason: item.rejected_reason && item.rejected_reason !== 'NONE' ? item.rejected_reason : null,
      }));
  }

  async createTemplate(wabaId: string, payload: unknown): Promise<{ id: string; status: string; category: string }> {
    const json = await this.graph('POST', `${encodeURIComponent(wabaId)}/message_templates`, payload);
    return { id: String(json.id), status: json.status ?? 'PENDING', category: json.category ?? 'UTILITY' };
  }

  async sendTemplate(input: {
    phoneId: string;
    to: string;
    name: string;
    language: string;
    params: string[];
  }): Promise<{ messageId: string | null }> {
    const json = await this.graph('POST', `${encodeURIComponent(input.phoneId)}/messages`, {
      messaging_product: 'whatsapp',
      to: input.to.replace(/^\+/, ''),
      type: 'template',
      template: {
        name: input.name,
        language: { code: input.language },
        components: [{ type: 'body', parameters: input.params.map(text => ({ type: 'text', text })) }],
      },
    });
    return { messageId: json?.messages?.[0]?.id ?? null };
  }
}

/** Motivos de rechazo de plantilla que da Meta, en español. */
export function rejectionReasonText(reason: string | null): string | null {
  if (!reason) return null;
  const known: Record<string, string> = {
    INVALID_FORMAT: 'El formato del texto o de las variables no es válido.',
    ABUSIVE_CONTENT: 'Meta consideró el contenido abusivo.',
    TAG_CONTENT_MISMATCH: 'El texto no coincide con la categoría (Utilidad).',
    SCAM: 'Meta lo marcó como posible estafa.',
    PROMOTIONAL: 'Meta lo consideró promocional para la categoría elegida.',
    INCORRECT_CATEGORY: 'La categoría elegida no corresponde al contenido.',
  };
  return known[reason] ?? `Meta lo rechazó (${reason}).`;
}
