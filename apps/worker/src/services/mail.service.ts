import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

interface EmailOptions {
  to: string;
  subject: string;
  html: string;
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

  private async sendEmail(options: EmailOptions): Promise<void> {
    const from = this.configService.get('EMAIL_FROM', 'noreply@lucilamon.com');

    // Resend manda cuando hay clave: una petición HTTP, sin transporte SMTP que
    // mantener. El camino de nodemailer se conserva para no obligar a migrar
    // los despliegues que ya usaran SendGrid o un SMTP propio.
    const resendApiKey = this.configService.get('RESEND_API_KEY');
    if (resendApiKey) {
      const recipients = Array.isArray(options.to) ? options.to : [options.to];
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${resendApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ from, to: recipients, subject: options.subject, html: options.html }),
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`Resend devolvió ${response.status}: ${detail.slice(0, 200)}`);
      }
      return;
    }

    await this.transporter.sendMail({ from, ...options });
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
