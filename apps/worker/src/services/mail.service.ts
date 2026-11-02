import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

interface EmailOptions {
  to: string;
  subject: string;
  html: string;
  headers?: Record<string, string>;
  /** Nombre visible del remitente cuando se envía con la cuenta de la plataforma. */
  fromDisplayName?: string | null;
  attachments?: Array<{
    filename: string;
    path: string;
  }>;
}

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private transporter: nodemailer.Transporter;

  constructor(private configService: ConfigService) {
    this.setupTransporter();
  }

  private setupTransporter() {
    const sendgridApiKey = this.configService.get('SENDGRID_API_KEY');
    const service = this.configService.get('EMAIL_SERVICE', 'sendgrid');
    const smtpHost = this.configService.get('SMTP_HOST');

    // Con Resend no hace falta transporte SMTP: el envío no pasa por aquí.
    if (this.configService.get('RESEND_API_KEY')) return;

    if ((service === 'sendgrid' && !sendgridApiKey) || (service !== 'sendgrid' && !smtpHost)) {
      if (this.configService.get('NODE_ENV') === 'production') {
        throw new Error('Configura SENDGRID_API_KEY o un transporte SMTP para enviar emails');
      }
      this.logger.warn('No email credentials found. Using local test transporter.');
      this.transporter = nodemailer.createTransport({
        streamTransport: true,
        newline: 'unix',
        buffer: true
      });
      return;
    }

    if (service === 'sendgrid') {
      this.transporter = nodemailer.createTransport({
        service: 'SendGrid',
        auth: {
          user: 'apikey',
          pass: sendgridApiKey,
        },
      });
    } else {
      // Configuration for other services like SES, SMTP, etc.
      this.transporter = nodemailer.createTransport({
        host: this.configService.get('SMTP_HOST'),
        port: this.configService.get('SMTP_PORT', 587),
        secure: false,
        auth: {
          user: this.configService.get('SMTP_USER'),
          pass: this.configService.get('SMTP_PASS'),
        },
      });
    }
  }

  async sendBibNotification(
    email: string,
    bib: string,
    eventName: string,
    photos: Array<{ photoId: string; thumbUrl: string; watermarkUrl: string }>,
  ): Promise<void> {
    try {
      const subject = `📸 Nuevas fotos de tu dorsal ${bib} - ${eventName}`;
      
      const html = this.generateBibNotificationTemplate(bib, eventName, photos);

      await this.sendEmail({
        to: email,
        subject,
        html,
      });

      this.logger.log(`Email enviado para dorsal ${bib}`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Error desconocido';
      const errorStack = error instanceof Error ? error.stack : undefined;
      this.logger.error(`Error enviando email: ${errorMessage}`, errorStack);
      throw error;
    }
  }

  async sendOrderConfirmation(
    email: string,
    orderId: string,
    eventName: string,
    downloadUrl: string,
  ): Promise<void> {
    try {
      const subject = `✅ Fotos compradas - ${eventName}`;
      
      const html = this.generateOrderConfirmationTemplate(orderId, eventName, downloadUrl);

      await this.sendEmail({
        to: email,
        subject,
        html,
      });

      this.logger.log(`Email de confirmación enviado para pedido ${orderId}`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Error desconocido';
      const errorStack = error instanceof Error ? error.stack : undefined;
      this.logger.error(`Error enviando confirmación: ${errorMessage}`, errorStack);
      throw error;
    }
  }

  async sendEventInvitation(input: {
    email: string;
    eventName: string;
    workspaceName: string;
    acceptanceUrl: string;
    organizerCommissionPercent: number;
    rightsTerms?: string;
  }): Promise<void> {
    const eventName = this.escapeHtml(input.eventName);
    const workspaceName = this.escapeHtml(input.workspaceName);
    const acceptanceUrl = this.escapeHtml(input.acceptanceUrl);
    const rightsTerms = this.escapeHtml(input.rightsTerms || 'Conservas la autoría y autorizas la publicación y venta de las fotos que aportes.');
    await this.sendEmail({
      to: input.email,
      subject: `${input.workspaceName} te invita a fotografiar ${input.eventName}`,
      html: `<!doctype html><html><body style="font-family:Arial,sans-serif;background:#f4f1ea;padding:32px;color:#171717"><div style="max-width:600px;margin:auto;background:#fff;border-radius:20px;padding:36px"><p style="font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#666">Invitación de ${workspaceName}</p><h1 style="font-size:34px;line-height:1.05">Participa en ${eventName}</h1><p>Tu espacio de fotógrafo conservará la atribución de cada imagen. El organizador recibirá <strong>${input.organizerCommissionPercent}%</strong> de tus ventas después de la comisión de plataforma.</p><div style="background:#f5f5f5;border-radius:12px;padding:16px;margin:24px 0"><strong>Condiciones</strong><p style="margin-bottom:0">${rightsTerms}</p></div><a href="${acceptanceUrl}" style="display:inline-block;background:#171717;color:#fff;padding:14px 24px;border-radius:999px;text-decoration:none;font-weight:bold">Revisar y aceptar invitación</a><p style="font-size:12px;color:#777;margin-top:30px">Si no esperabas esta invitación, puedes ignorar este correo.</p></div></body></html>`,
    });
  }

  /**
   * Arma el correo de resumen para quien se registró: un solo mensaje con las
   * fotos nuevas, una baja a un clic y las cabeceras que Gmail y Apple Mail
   * necesitan para mostrar «darse de baja». Es independiente de quién lo envíe:
   * lo manda el Resend del cliente o, si no tiene, el de LucilaMon.
   */
  buildRunnerDigest(input: {
    locale: 'es' | 'en';
    name?: string | null;
    bib: string;
    eventName: string;
    previews: string[];
    totalPhotos: number;
    eventUrl: string;
    unsubscribeUrl: string;
    unsubscribePostUrl?: string;
  }): { subject: string; html: string; headers: Record<string, string> } {
    const en = input.locale === 'en';
    const e = (value: string) => this.escapeHtml(value);
    const subject = en
      ? `📸 Your photos from ${input.eventName} are ready`
      : `📸 Ya están tus fotos de ${input.eventName}`;
    const greeting = input.name?.trim()
      ? (en ? `Hi ${e(input.name.trim())},` : `Hola ${e(input.name.trim())},`)
      : (en ? 'Hi,' : 'Hola,');
    const count = input.totalPhotos;
    const headline = en
      ? `${count} new photo${count === 1 ? '' : 's'} of bib ${e(input.bib)}`
      : `${count} foto${count === 1 ? '' : 's'} nueva${count === 1 ? '' : 's'} del dorsal ${e(input.bib)}`;
    const intro = en
      ? `We found photos of you at <strong>${e(input.eventName)}</strong>. Previews are watermarked; open your gallery to see and get them.`
      : `Encontramos fotos tuyas en <strong>${e(input.eventName)}</strong>. Las vistas previas llevan marca de agua; abre tu galería para verlas y conseguirlas.`;
    const cta = en ? 'See my photos' : 'Ver mis fotos';
    const more = count > input.previews.length
      ? `<p style="text-align:center;color:#777;font-size:13px">${en ? `and ${count - input.previews.length} more` : `y ${count - input.previews.length} más`}</p>`
      : '';
    const footer = en
      ? `You are receiving this because you asked to be notified about bib ${e(input.bib)}. <a href="${e(input.unsubscribeUrl)}" style="color:#777">Unsubscribe</a>.`
      : `Recibes este correo porque pediste que te avisáramos del dorsal ${e(input.bib)}. <a href="${e(input.unsubscribeUrl)}" style="color:#777">Darme de baja</a>.`;
    const images = input.previews
      .map(url => `<a href="${e(input.eventUrl)}"><img src="${e(url)}" alt="" width="176" style="width:176px;height:auto;border-radius:10px;margin:4px"></a>`)
      .join('');

    const html = `<!doctype html><html><body style="font-family:Arial,sans-serif;background:#f4f1ea;padding:28px 12px;color:#171717"><div style="max-width:600px;margin:auto;background:#fff;border-radius:20px;padding:32px"><h1 style="font-size:26px;line-height:1.15;margin:0 0 14px">${headline}</h1><p>${greeting}</p><p>${intro}</p><div style="text-align:center;margin:24px 0">${images}${more}</div><p style="text-align:center;margin:28px 0"><a href="${e(input.eventUrl)}" style="display:inline-block;background:#171717;color:#fff;padding:14px 28px;border-radius:999px;text-decoration:none;font-weight:bold">${cta}</a></p><p style="font-size:12px;color:#888;border-top:1px solid #eee;padding-top:16px;margin-top:28px">${footer}</p></div></body></html>`;

    const headers: Record<string, string> = {
      'List-Unsubscribe': input.unsubscribePostUrl
        ? `<${input.unsubscribePostUrl}>, <${input.unsubscribeUrl}>`
        : `<${input.unsubscribeUrl}>`,
    };
    if (input.unsubscribePostUrl) headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
    return { subject, html, headers };
  }

  /**
   * Envío con la cuenta de LucilaMon (cuando el espacio no conectó la suya).
   * El nombre del remitente es el del espacio, para que el corredor lo reconozca.
   */
  async sendRunnerDigest(
    input: Parameters<MailService['buildRunnerDigest']>[0] & { to: string; fromDisplayName?: string | null },
  ): Promise<void> {
    const { subject, html, headers } = this.buildRunnerDigest(input);
    await this.sendEmail({ to: input.to, subject, html, headers, fromDisplayName: input.fromDisplayName });
  }

  /** Aviso al cliente de que uno de sus canales dejó de funcionar. Sale siempre por la cuenta de LucilaMon. */
  async sendChannelAlert(input: {
    to: string;
    workspaceName: string;
    channel: 'EMAIL' | 'WHATSAPP';
    message: string;
    action?: string;
    helpUrl?: string;
    dashboardUrl: string;
  }): Promise<void> {
    const e = (value: string) => this.escapeHtml(value);
    const label = input.channel === 'EMAIL' ? 'correo (Resend)' : 'WhatsApp';
    const html = `<!doctype html><html><body style="font-family:Arial,sans-serif;background:#f4f1ea;padding:28px 12px;color:#171717"><div style="max-width:600px;margin:auto;background:#fff;border-radius:20px;padding:32px"><p style="font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#a33">Avisos pausados</p><h1 style="font-size:24px;line-height:1.2;margin:6px 0 14px">Tu canal de ${label} dejó de enviar</h1><p>${e(input.message)}</p>${input.action ? `<p><strong>Qué hacer:</strong> ${e(input.action)}</p>` : ''}<p style="color:#555;font-size:14px">Este problema está en tu cuenta de ${input.channel === 'EMAIL' ? 'Resend' : 'Meta / WhatsApp'}, no en LucilaMon. Los avisos a tus corredores <strong>no se pierden</strong>: quedan en espera y saldrán en cuanto lo resuelvas.</p><p style="margin:24px 0">${input.helpUrl ? `<a href="${e(input.helpUrl)}" style="display:inline-block;background:#171717;color:#fff;padding:12px 22px;border-radius:999px;text-decoration:none;font-weight:bold">Ir a resolverlo</a> ` : ''}<a href="${e(input.dashboardUrl)}" style="color:#171717">Abrir LucilaMon</a></p><p style="font-size:12px;color:#888">Espacio: ${e(input.workspaceName)}. Recibes este correo porque eres el contacto de ese espacio.</p></div></body></html>`;
    await this.sendEmail({ to: input.to, subject: `Tus avisos de ${input.workspaceName} están pausados (${label})`, html });
  }

  private async sendEmail(options: EmailOptions): Promise<void> {
    const platformFrom = this.configService.get<string>('EMAIL_FROM', 'noreply@lucilamon.com');
    const address = /<([^>]+)>/.exec(platformFrom)?.[1] ?? platformFrom;
    const display = (options.fromDisplayName || '').replace(/[<>"\r\n]/g, '').trim();
    const from = display ? `${display} <${address}>` : platformFrom;

    // Resend manda cuando hay clave: una petición HTTP, sin transporte SMTP que
    // mantener. El camino de nodemailer se conserva para no obligar a migrar
    // los despliegues que ya usaran SendGrid o un SMTP propio.
    const resendApiKey = this.configService.get('RESEND_API_KEY');
    if (resendApiKey) {
      const recipients = Array.isArray(options.to) ? options.to : [options.to];
      const response = await fetch(`${process.env.RESEND_API_BASE || 'https://api.resend.com'}/emails`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${resendApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ from, to: recipients, subject: options.subject, html: options.html, headers: options.headers }),
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`Resend devolvió ${response.status}: ${detail.slice(0, 200)}`);
      }
      return;
    }

    const { fromDisplayName: _ignored, ...mail } = options;
    await this.transporter.sendMail({ from, ...mail });
  }

  private escapeHtml(value: string): string {
    return value.replace(/[&<>'"]/g, character => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;',
    })[character] || character);
  }

  private generateBibNotificationTemplate(
    bib: string,
    eventName: string,
    photos: Array<{ photoId: string; thumbUrl: string; watermarkUrl: string }>,
  ): string {
    const baseUrl = this.configService.get('FRONTEND_URL', 'https://tu-dominio.com');
    const safeBib = this.escapeHtml(bib);
    const safeEventName = this.escapeHtml(eventName);
    
    const photosHtml = photos
      .map(photo => `
        <div style="margin: 10px; display: inline-block;">
          <a href="${this.escapeHtml(baseUrl)}/search" style="text-decoration: none;">
            <img src="${this.escapeHtml(photo.thumbUrl)}" alt="Foto ${this.escapeHtml(photo.photoId)}"
                 style="width: 200px; height: auto; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
          </a>
        </div>
      `)
      .join('');

    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Nuevas fotos disponibles</title>
</head>
<body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="text-align: center; margin-bottom: 30px;">
    <h1 style="color: #2c3e50;">📸 ¡Nuevas fotos disponibles!</h1>
    <p style="font-size: 18px; color: #7f8c8d;">Dorsal ${safeBib} - ${safeEventName}</p>
  </div>
  
  <div style="margin-bottom: 30px;">
    <p>¡Hola!</p>
    <p>Tenemos buenas noticias: hemos encontrado nuevas fotos tuyas del evento <strong>${safeEventName}</strong>.</p>
    <p>Estas son las fotos de tu dorsal <strong>${safeBib}</strong>:</p>
  </div>

  <div style="text-align: center; margin: 30px 0;">
    ${photosHtml}
  </div>

  <div style="text-align: center; margin: 30px 0;">
    <a href="${this.escapeHtml(baseUrl)}/search"
       style="display: inline-block; background: #3498db; color: white; padding: 15px 30px; text-decoration: none; border-radius: 5px; font-weight: bold;">
      Ver todas mis fotos
    </a>
  </div>

  <div style="border-top: 1px solid #ecf0f1; padding-top: 20px; margin-top: 40px; font-size: 12px; color: #95a5a6; text-align: center;">
    <p>Este email fue enviado automáticamente. Si no quieres recibir más notificaciones, puedes darte de baja.</p>
    <p>© ${new Date().getFullYear()} LucilaMon</p>
  </div>
</body>
</html>
    `;
  }

  private generateOrderConfirmationTemplate(
    orderId: string,
    eventName: string,
    downloadUrl: string,
  ): string {
    const safeDownloadUrl = this.escapeHtml(downloadUrl);
    const safeOrderId = this.escapeHtml(orderId);
    const safeEventName = this.escapeHtml(eventName);

    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Confirmación de compra</title>
</head>
<body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="text-align: center; margin-bottom: 30px;">
    <h1 style="color: #27ae60;">✅ ¡Compra confirmada!</h1>
    <p style="font-size: 18px; color: #7f8c8d;">Pedido #${safeOrderId}</p>
  </div>
  
  <div style="margin-bottom: 30px;">
    <p>¡Gracias por tu compra!</p>
    <p>Tu pedido del evento <strong>${safeEventName}</strong> ha sido procesado correctamente.</p>
    <p>Puedes descargar tus fotos en alta resolución desde tu enlace privado:</p>
  </div>

  <div style="margin: 30px 0; text-align: center;">
    <a href="${safeDownloadUrl}" style="display:inline-block;background:#171717;color:#fff;padding:15px 28px;border-radius:999px;text-decoration:none;font-weight:bold">Descargar mis fotos</a>
  </div>

  <div style="background: #e8f4f8; padding: 15px; border-radius: 5px; margin: 20px 0;">
    <h3 style="margin: 0 0 10px 0; color: #2c3e50;">📋 Información importante:</h3>
    <ul style="margin: 0; padding-left: 20px;">
      <li>El acceso privado de este correo expira en 30 días</li>
      <li>Las fotos son de alta resolución sin marca de agua</li>
      <li>Guarda el comprobante de esta compra</li>
    </ul>
  </div>

  <div style="text-align: center; margin: 30px 0;">
    <a href="${safeDownloadUrl}"
       style="display: inline-block; background: #3498db; color: white; padding: 15px 30px; text-decoration: none; border-radius: 5px; font-weight: bold;">
      Ver detalles del pedido
    </a>
  </div>

  <div style="border-top: 1px solid #ecf0f1; padding-top: 20px; margin-top: 40px; font-size: 12px; color: #95a5a6; text-align: center;">
    <p>© ${new Date().getFullYear()} LucilaMon</p>
  </div>
</body>
</html>
    `;
  }
}
