import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PrismaService } from '../common/services/prisma.service';
import { ClassifiedError } from './delivery-errors';
import { ChannelKind, EmailChannelConfig, WhatsAppChannelConfig, pickTemplate } from './channel-config';
import { ResendClient, formatFrom } from './resend.client';
import { WhatsAppClient } from './whatsapp.client';
import { SecretBox } from './secret-box';
import { TemplateLocale } from './whatsapp-templates';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

export type EmailRoute =
  | { kind: 'PLATFORM' }
  | { kind: 'OWN'; client: ResendClient; from: string; replyTo?: string }
  | { kind: 'PAUSED'; message: string };

export type WhatsAppRoute =
  | { kind: 'NONE' }
  | { kind: 'PAUSED'; message: string }
  | { kind: 'OWN'; client: WhatsAppClient; phoneId: string; template: { name: string; language: string } };

/**
 * Decide con qué canal sale cada aviso y deja constancia de lo que falla.
 *
 * Regla de fondo: las credenciales y el saldo son del cliente. Cuando su cuenta
 * rechaza un envío, el canal se pausa (no se insiste ni se pierde el aviso), se
 * guarda el motivo con lo que debe hacer y se le avisa por correo una sola vez.
 */
@Injectable()
export class ChannelHealthService {
  private readonly logger = new Logger(ChannelHealthService.name);
  private readonly box: SecretBox;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.box = new SecretBox(config.get<string>('PARTNER_WEBHOOK_ENCRYPTION_KEY'), config.get('NODE_ENV') === 'production');
  }

  get secretBox() {
    return this.box;
  }

  async emailRoute(workspaceId: string | null | undefined): Promise<EmailRoute> {
    if (!workspaceId) return { kind: 'PLATFORM' };
    const row = await this.prisma.workspaceChannel.findUnique({ where: { workspaceId_channel: { workspaceId, channel: 'EMAIL' } } });
    if (!row || row.status === 'DISABLED' || row.status === 'PENDING') return { kind: 'PLATFORM' };
    const config = row.config as unknown as EmailChannelConfig;
    if (row.status === 'ERROR') {
      if (config.fallbackToPlatform) return { kind: 'PLATFORM' };
      return { kind: 'PAUSED', message: row.lastErrorMessage || 'El correo del espacio está pausado.' };
    }
    return {
      kind: 'OWN',
      client: new ResendClient(this.box.decrypt(row.secretEnc)),
      from: formatFrom(config.fromEmail, config.fromName),
      replyTo: config.replyTo || undefined,
    };
  }

  async whatsappRoute(workspaceId: string | null | undefined, locale: TemplateLocale): Promise<WhatsAppRoute> {
    if (!workspaceId) return { kind: 'NONE' };
    const row = await this.prisma.workspaceChannel.findUnique({ where: { workspaceId_channel: { workspaceId, channel: 'WHATSAPP' } } });
    if (!row || row.status === 'DISABLED' || row.status === 'PENDING') return { kind: 'NONE' };
    if (row.status === 'ERROR') return { kind: 'PAUSED', message: row.lastErrorMessage || 'WhatsApp está pausado.' };
    const config = row.config as unknown as WhatsAppChannelConfig;
    const template = pickTemplate(config, locale);
    if (!template) return { kind: 'PAUSED', message: 'No hay una plantilla de WhatsApp aprobada.' };
    return {
      kind: 'OWN',
      client: new WhatsAppClient(this.box.decrypt(row.secretEnc)),
      phoneId: config.phoneId,
      template: { name: template.name, language: template.language },
    };
  }

  /**
   * Registra un aviso fallido. Los fallos de la cuenta o de la plantilla pausan
   * el canal. Devuelve si hay que avisar al cliente (una vez por motivo y día).
   */
  async recordFailure(
    workspaceId: string,
    channel: ChannelKind,
    error: ClassifiedError,
    context: { eventId?: string; subscriptionId?: string } = {},
  ): Promise<{ alert: boolean }> {
    if (error.scope === 'LIMIT' || error.scope === 'TRANSIENT') {
      // Los reintentos de un límite repetirían la misma fila cada pocos minutos.
      const recent = await this.prisma.deliveryIssue.findFirst({
        where: { workspaceId, channel, code: error.code, createdAt: { gte: new Date(Date.now() - HOUR_MS) } },
        select: { id: true },
      });
      if (recent) return { alert: false };
    }

    await this.prisma.deliveryIssue.create({
      data: {
        workspaceId, channel, scope: error.scope, code: error.code.slice(0, 40), message: error.message.slice(0, 600),
        eventId: context.eventId ?? null, subscriptionId: context.subscriptionId ?? null,
      },
    }).catch(error_ => this.logger.warn(`No se pudo guardar el fallo de entrega: ${error_?.message}`));

    if (error.scope !== 'ACCOUNT' && error.scope !== 'TEMPLATE') return { alert: false };

    const row = await this.prisma.workspaceChannel.findUnique({ where: { workspaceId_channel: { workspaceId, channel } } });
    if (!row) return { alert: false };
    const message = [error.message, error.action].filter(Boolean).join(' ').slice(0, 600);
    const repeated = row.lastAlertCode === error.code && row.lastAlertAt && Date.now() - row.lastAlertAt.getTime() < DAY_MS;
    await this.prisma.workspaceChannel.update({
      where: { id: row.id },
      data: {
        status: 'ERROR',
        lastErrorCode: error.code.slice(0, 40),
        lastErrorMessage: message,
        lastCheckedAt: new Date(),
        ...(repeated ? {} : { lastAlertAt: new Date(), lastAlertCode: error.code.slice(0, 40) }),
      },
    });
    return { alert: !repeated };
  }

  /** A quién se le avisa de un problema del canal: el contacto del espacio o, si no, su dueño. */
  async alertRecipient(workspaceId: string): Promise<{ email: string; workspaceName: string } | null> {
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { name: true, contactEmail: true, owner: { select: { email: true } } },
    });
    const email = workspace?.contactEmail || workspace?.owner?.email;
    return workspace && email ? { email, workspaceName: workspace.name } : null;
  }
}
