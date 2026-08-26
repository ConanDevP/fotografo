import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Envío de correo por Resend.
 *
 * Usa su API HTTP en lugar de SMTP: una petición con `fetch`, sin dependencias
 * nuevas ni un transporte que mantener. Si no hay clave configurada, el correo
 * no se envía pero tampoco rompe nada — se registra en el log, que es lo que
 * permite trabajar en local sin credenciales.
 */
@Injectable()
export class MailerService {
  private readonly logger = new Logger(MailerService.name);
  private readonly apiKey: string | undefined;
  private readonly from: string;

  constructor(private readonly config: ConfigService) {
    this.apiKey = this.config.get<string>('RESEND_API_KEY') || undefined;
    this.from = this.config.get<string>('EMAIL_FROM') || 'LucilaMon <no-reply@lucilamon.com>';
    if (!this.apiKey) {
      this.logger.warn('RESEND_API_KEY sin configurar: los correos se escribirán en el log');
    }
  }

  get isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  /**
   * Devuelve si salió o no, sin lanzar.
   *
   * Quien llama decide qué hacer: un fallo de correo no debe tumbar la acción
   * que lo originó ni, en el caso de la recuperación de contraseña, delatar si
   * una cuenta existe.
   */
  async send(input: { to: string; subject: string; html: string }): Promise<boolean> {
    if (!this.apiKey) {
      this.logger.warn(`[SIN CORREO] Para ${input.to}: ${input.subject}`);
      return false;
    }

    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: this.from,
          to: [input.to],
          subject: input.subject,
          html: input.html,
        }),
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        this.logger.error(`Resend devolvió ${response.status} para ${input.to}: ${detail.slice(0, 200)}`);
        return false;
      }
      return true;
    } catch (error) {
      this.logger.error(
        `No se pudo enviar a ${input.to}: ${error instanceof Error ? error.message : 'desconocido'}`,
      );
      return false;
    }
  }
}
