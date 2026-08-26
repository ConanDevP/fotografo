import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'crypto';
import * as argon2 from 'argon2';

import { PrismaService } from '../common/services/prisma.service';
import { MailerService } from '../common/services/mailer.service';

/** Una hora. Suficiente para leer el correo, corto para que caduque solo. */
const TOKEN_TTL_MS = 60 * 60 * 1000;
/** Enlaces por hora y cuenta. Frena el uso del formulario como arma de spam. */
const MAX_PER_HOUR = 3;

@Injectable()
export class PasswordResetService {
  private readonly logger = new Logger(PasswordResetService.name);
  private readonly appUrl: string;
  private readonly from: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly mailer: MailerService,
  ) {
    this.appUrl = this.config.get<string>('APP_URL') || 'http://localhost:3000';
    this.from = this.config.get<string>('EMAIL_FROM') || 'no-reply@lucilamon.com';
  }

  /**
   * Siempre responde lo mismo, exista la cuenta o no. Si distinguiera, el
   * formulario se convertiría en una forma de averiguar quién está registrado.
   */
  async request(email: string): Promise<{ sent: true }> {
    const normalized = email.trim().toLowerCase();
    const user = await this.prisma.user.findUnique({
      where: { email: normalized },
      select: { id: true, email: true, name: true, passwordHash: true },
    });

    // Sin contraseña la cuenta entró por otro medio; no hay nada que reponer.
    if (!user?.passwordHash) return { sent: true };

    const recent = await this.prisma.passwordResetToken.count({
      where: { userId: user.id, createdAt: { gt: new Date(Date.now() - 60 * 60 * 1000) } },
    });
    if (recent >= MAX_PER_HOUR) {
      this.logger.warn(`Demasiadas solicitudes de recuperación para ${user.id}`);
      return { sent: true };
    }

    const token = randomBytes(32).toString('hex');
    await this.prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: this.hash(token),
        expiresAt: new Date(Date.now() + TOKEN_TTL_MS),
      },
    });

    await this.send(user.email, user.name, token);
    return { sent: true };
  }

  async reset(token: string, newPassword: string): Promise<{ reset: true }> {
    const record = await this.prisma.passwordResetToken.findUnique({
      where: { tokenHash: this.hash(token) },
      select: { id: true, userId: true, expiresAt: true, usedAt: true },
    });

    // Un solo mensaje para caducado, usado e inexistente: distinguirlos solo
    // ayudaría a quien esté probando enlaces.
    if (!record || record.usedAt || record.expiresAt < new Date()) {
      throw new BadRequestException({
        code: 'RESET_TOKEN_INVALID',
        message: 'El enlace no es válido o ya caducó. Pide uno nuevo.',
      });
    }

    const passwordHash = await argon2.hash(newPassword);
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: record.userId }, data: { passwordHash } }),
      this.prisma.passwordResetToken.update({
        where: { id: record.id },
        data: { usedAt: new Date() },
      }),
      // Los demás enlaces vivos de esa cuenta dejan de servir: si alguien pidió
      // varios, el que no se usó no debe quedar abierto.
      this.prisma.passwordResetToken.updateMany({
        where: { userId: record.userId, usedAt: null },
        data: { usedAt: new Date() },
      }),
    ]);

    this.logger.log(`Contraseña restablecida para ${record.userId}`);
    return { reset: true };
  }

  private hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private async send(email: string, name: string | null, token: string): Promise<void> {
    const link = `${this.appUrl.replace(/\/$/, '')}/auth/reset-password?token=${token}`;

    const sent = await this.mailer.send({
      to: email,
      subject: 'Restablece tu contraseña de LucilaMon',
      html: `
          <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;color:#171714">
            <h1 style="font-size:22px;margin:0 0 16px">Restablece tu contraseña</h1>
            <p style="line-height:1.6">Hola${name ? ` ${name}` : ''}, pediste volver a entrar en tu cuenta.</p>
            <p style="line-height:1.6">Este enlace caduca en una hora y solo se puede usar una vez.</p>
            <p style="margin:28px 0">
              <a href="${link}" style="background:#171714;color:#fff8ec;padding:14px 28px;border-radius:999px;text-decoration:none;font-weight:bold;display:inline-block">Elegir contraseña nueva</a>
            </p>
            <p style="line-height:1.6;color:#6b6b64;font-size:13px">
              Si no lo pediste, ignora este correo: tu contraseña actual sigue funcionando.
            </p>
          </div>
      `,
    });

    // Sin transporte configurado el enlace queda en el log, que es lo que
    // permite probar el flujo en local sin credenciales.
    if (!sent && !this.mailer.isConfigured) {
      this.logger.warn(`[SIN CORREO] Enlace de recuperación para ${email}: ${link}`);
    }
  }
}
