import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export class WhatsAppDeliveryError extends Error {
  constructor(message: string, readonly permanent: boolean) {
    super(message);
  }
}

export interface PhotosReadyMessage {
  /** Teléfono en E.164, con o sin "+". */
  to: string;
  locale: 'es' | 'en';
  name?: string | null;
  eventName: string;
  photoCount: number;
  url: string;
}

/**
 * WhatsApp Business Cloud API (Meta). Solo puede iniciar una conversación con
 * una plantilla aprobada, así que el texto vive en Meta, no aquí. La plantilla
 * recibe cuatro variables en el cuerpo, en este orden:
 *   {{1}} nombre · {{2}} evento · {{3}} cantidad de fotos · {{4}} enlace
 * Se configura con WHATSAPP_TOKEN, WHATSAPP_PHONE_ID y WHATSAPP_TEMPLATE_ES
 * (opcional WHATSAPP_TEMPLATE_EN); sin ellas el canal queda apagado.
 */
@Injectable()
export class WhatsAppService {
  private readonly logger = new Logger(WhatsAppService.name);

  constructor(private readonly config: ConfigService) {}

  enabled(): boolean {
    return !!(
      this.config.get('WHATSAPP_TOKEN')
      && this.config.get('WHATSAPP_PHONE_ID')
      && this.config.get('WHATSAPP_TEMPLATE_ES')
    );
  }

  async sendPhotosReady(message: PhotosReadyMessage): Promise<void> {
    const template = message.locale === 'en' && this.config.get('WHATSAPP_TEMPLATE_EN')
      ? { name: this.config.get<string>('WHATSAPP_TEMPLATE_EN')!, language: 'en' }
      : { name: this.config.get<string>('WHATSAPP_TEMPLATE_ES')!, language: 'es' };
    const version = this.config.get<string>('WHATSAPP_API_VERSION', 'v21.0');
    const phoneId = this.config.get<string>('WHATSAPP_PHONE_ID');

    const response = await fetch(`https://graph.facebook.com/${version}/${phoneId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.get('WHATSAPP_TOKEN')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: message.to.replace(/^\+/, ''),
        type: 'template',
        template: {
          name: template.name,
          language: { code: template.language },
          components: [
            {
              type: 'body',
              parameters: [
                message.name?.trim() || (message.locale === 'en' ? 'runner' : 'corredor'),
                message.eventName,
                String(message.photoCount),
                message.url,
              ].map(text => ({ type: 'text', text })),
            },
          ],
        },
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (response.ok) return;

    const detail = await response.text().catch(() => '');
    // 429 y 5xx se arreglan solos; el resto (número sin WhatsApp, plantilla
    // inexistente, parámetros mal) no mejora reintentando.
    const transient = response.status === 429 || response.status >= 500;
    this.logger.warn(`WhatsApp devolvió ${response.status}: ${detail.slice(0, 300)}`);
    throw new WhatsAppDeliveryError(`WhatsApp devolvió ${response.status}`, !transient);
  }
}
