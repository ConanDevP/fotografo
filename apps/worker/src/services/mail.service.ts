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
    
    // Si no hay credenciales de email, usar un transportador de prueba
    if (!sendgridApiKey) {
      this.logger.warn('No email credentials found. Using test transporter.');
      this.transporter = nodemailer.createTransport({
        streamTransport: true,
        newline: 'unix',
        buffer: true
      });
      return;
    }

    const service = this.configService.get('EMAIL_SERVICE', 'sendgrid');
    
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

      this.logger.log(`Email enviado a ${email} para dorsal ${bib}`);
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
    photos: Array<{ photoId: string; originalUrl: string }>,
  ): Promise<void> {
    try {
      const subject = `✅ Fotos compradas - ${eventName}`;
      
      const html = this.generateOrderConfirmationTemplate(orderId, eventName, photos);

      await this.sendEmail({
        to: email,
        subject,
        html,
      });

      this.logger.log(`Email de confirmación enviado a ${email} para pedido ${orderId}`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Error desconocido';
      const errorStack = error instanceof Error ? error.stack : undefined;
      this.logger.error(`Error enviando confirmación: ${errorMessage}`, errorStack);
      throw error;
    }
  }

  private async sendEmail(options: EmailOptions): Promise<void> {
    const mailOptions = {
      from: this.configService.get('EMAIL_FROM', 'noreply@fotografos.com'),
      ...options,
    };

    await this.transporter.sendMail(mailOptions);
  }

  private generateBibNotificationTemplate(
    bib: string,
    eventName: string,
    photos: Array<{ photoId: string; thumbUrl: string; watermarkUrl: string }>,
  ): string {
    const baseUrl = this.configService.get('FRONTEND_URL', 'https://tu-dominio.com');
    
    const photosHtml = photos
      .map(photo => `
        <div style="margin: 10px; display: inline-block;">
          <a href="${baseUrl}/photos/${photo.photoId}" style="text-decoration: none;">
            <img src="${photo.thumbUrl}" alt="Foto ${photo.photoId}" 
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
    <p style="font-size: 18px; color: #7f8c8d;">Dorsal ${bib} - ${eventName}</p>
  </div>
  
  <div style="margin-bottom: 30px;">
    <p>¡Hola!</p>
    <p>Tenemos buenas noticias: hemos encontrado nuevas fotos tuyas del evento <strong>${eventName}</strong>.</p>
    <p>Estas son las fotos de tu dorsal <strong>${bib}</strong>:</p>
  </div>

  <div style="text-align: center; margin: 30px 0;">
    ${photosHtml}
  </div>

  <div style="text-align: center; margin: 30px 0;">
    <a href="${baseUrl}/events/${eventName}/search?bib=${bib}" 
       style="display: inline-block; background: #3498db; color: white; padding: 15px 30px; text-decoration: none; border-radius: 5px; font-weight: bold;">
      Ver todas mis fotos
    </a>
  </div>

  <div style="border-top: 1px solid #ecf0f1; padding-top: 20px; margin-top: 40px; font-size: 12px; color: #95a5a6; text-align: center;">
    <p>Este email fue enviado automáticamente. Si no quieres recibir más notificaciones, puedes darte de baja.</p>
    <p>© 2025 Fotografos Platform</p>
  </div>
</body>
</html>
    `;
  }

  private generateOrderConfirmationTemplate(
    orderId: string,
    eventName: string,
    photos: Array<{ photoId: string; originalUrl: string }>,
  ): string {
    const baseUrl = this.configService.get('FRONTEND_URL', 'https://tu-dominio.com');
    
    const downloadLinks = photos
      .map(photo => `
        <div style="margin: 10px 0; padding: 15px; background: #f8f9fa; border-radius: 5px;">
          <a href="${baseUrl}/photos/${photo.photoId}/download" 
             style="color: #3498db; text-decoration: none; font-weight: bold;">
            📷 Descargar foto ${photo.photoId}
          </a>
        </div>
      `)
      .join('');

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
    <p style="font-size: 18px; color: #7f8c8d;">Pedido #${orderId}</p>
  </div>
  
  <div style="margin-bottom: 30px;">
    <p>¡Gracias por tu compra!</p>
    <p>Tu pedido del evento <strong>${eventName}</strong> ha sido procesado correctamente.</p>
    <p>Puedes descargar tus fotos en alta resolución usando los siguientes enlaces:</p>
  </div>

  <div style="margin: 30px 0;">
    ${downloadLinks}
  </div>

  <div style="background: #e8f4f8; padding: 15px; border-radius: 5px; margin: 20px 0;">
    <h3 style="margin: 0 0 10px 0; color: #2c3e50;">📋 Información importante:</h3>
    <ul style="margin: 0; padding-left: 20px;">
      <li>Los enlaces de descarga expiran en 48 horas</li>
      <li>Las fotos son de alta resolución sin marca de agua</li>
      <li>Guarda el comprobante de esta compra</li>
    </ul>
  </div>

  <div style="text-align: center; margin: 30px 0;">
    <a href="${baseUrl}/orders/${orderId}" 
       style="display: inline-block; background: #3498db; color: white; padding: 15px 30px; text-decoration: none; border-radius: 5px; font-weight: bold;">
      Ver detalles del pedido
    </a>
  </div>

  <div style="border-top: 1px solid #ecf0f1; padding-top: 20px; margin-top: 40px; font-size: 12px; color: #95a5a6; text-align: center;">
    <p>© 2025 Fotografos Platform</p>
  </div>
</body>
</html>
    `;
  }
}