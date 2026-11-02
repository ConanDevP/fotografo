import { ChannelSendError, classifyResendError, networkError } from './delivery-errors';

export interface ResendDomain {
  id: string;
  name: string;
  /** verified | not_started | pending | failed | temporary_failure */
  status: string;
}

export interface ResendEmail {
  from: string;
  to: string | string[];
  subject: string;
  html: string;
  replyTo?: string;
  headers?: Record<string, string>;
}

/** Configurable solo para pruebas con un proveedor simulado. */
const BASE = process.env.RESEND_API_BASE || 'https://api.resend.com';

/** Cliente mínimo de Resend con la clave del propio cliente. Todo error sale clasificado. */
export class ResendClient {
  constructor(
    private readonly apiKey: string,
    private readonly timeoutMs = 15_000,
  ) {}

  private async call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<any> {
    let response: Response;
    try {
      response = await fetch(`${BASE}${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new ChannelSendError(networkError('EMAIL', error));
    }
    const json = await response.json().catch(() => null);
    if (!response.ok) throw new ChannelSendError(classifyResendError(response.status, json));
    return json;
  }

  /**
   * Dominios de la cuenta. Una clave «solo envío» no puede listarlos: se
   * devuelve RESTRICTED y la validación pasa a ser un envío de prueba.
   */
  async listDomains(): Promise<{ kind: 'OK'; domains: ResendDomain[] } | { kind: 'RESTRICTED' }> {
    try {
      const json = await this.call('GET', '/domains');
      const data: any[] = Array.isArray(json?.data) ? json.data : [];
      return { kind: 'OK', domains: data.map(item => ({ id: item.id, name: String(item.name).toLowerCase(), status: item.status })) };
    } catch (error) {
      if (error instanceof ChannelSendError && error.detail.code === 'EMAIL_KEY_RESTRICTED') return { kind: 'RESTRICTED' };
      throw error;
    }
  }

  async getDomain(id: string): Promise<ResendDomain> {
    const json = await this.call('GET', `/domains/${encodeURIComponent(id)}`);
    return { id: json.id, name: String(json.name).toLowerCase(), status: json.status };
  }

  /** Pide a Resend que vuelva a comprobar los DNS. */
  async verifyDomain(id: string): Promise<void> {
    await this.call('POST', `/domains/${encodeURIComponent(id)}/verify`);
  }

  async send(email: ResendEmail): Promise<{ id: string }> {
    const json = await this.call('POST', '/emails', {
      from: email.from,
      to: Array.isArray(email.to) ? email.to : [email.to],
      subject: email.subject,
      html: email.html,
      ...(email.replyTo ? { reply_to: email.replyTo } : {}),
      ...(email.headers ? { headers: email.headers } : {}),
    });
    return { id: json?.id };
  }
}

/** Remitente con nombre: `Club Cronos <fotos@club.com>`. El nombre se limpia para no romper la cabecera. */
export function formatFrom(email: string, name?: string | null): string {
  const clean = (name || '').replace(/[<>"\r\n]/g, '').trim();
  return clean ? `${clean} <${email}>` : email;
}
