import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, WorkspaceRole } from '@prisma/client';

import { PrismaService } from '../common/services/prisma.service';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { DigestSchedulerService } from '../common/services/digest-scheduler.service';
import { MailerService } from '../common/services/mailer.service';
import { normalizePhone } from '../common/utils/phone';
import { ChannelHealthService } from './channel-health.service';
import {
  ChannelKind, ChannelStatus, EmailChannelConfig, WhatsAppChannelConfig, WhatsAppTemplateState,
  approvedTemplates, whatsappStatusFor,
} from './channel-config';
import { ChannelSendError, ClassifiedError } from './delivery-errors';
import { ResendClient, formatFrom } from './resend.client';
import { WhatsAppClient, rejectionReasonText } from './whatsapp.client';
import { SecretBox } from './secret-box';
import {
  TEMPLATE_BASE_NAME, TEMPLATE_LOCALES, TemplateLocale, cleanTemplateParam, templateCreationPayload, templateName,
} from './whatsapp-templates';
import { ConnectEmailDto, ConnectWhatsAppDto, UpdateEmailSettingsDto } from './dto/channels.dto';

const MANAGERS: WorkspaceRole[] = [WorkspaceRole.OWNER, WorkspaceRole.ADMIN];
const nowIso = () => new Date().toISOString();

type ChannelRow = NonNullable<Awaited<ReturnType<PrismaService['workspaceChannel']['findFirst']>>>;

@Injectable()
export class ChannelsService {
  private readonly logger = new Logger(ChannelsService.name);
  private readonly box: SecretBox;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly workspaces: WorkspacesService,
    private readonly scheduler: DigestSchedulerService,
    private readonly mailer: MailerService,
    private readonly health: ChannelHealthService,
  ) {
    this.box = health.secretBox;
  }

  // ── Lectura ───────────────────────────────────────────────────────────────

  async overview(workspaceId: string, userId: string) {
    await this.workspaces.assertAccess(workspaceId, userId, MANAGERS);
    const [rows, issues, recent] = await Promise.all([
      this.prisma.workspaceChannel.findMany({ where: { workspaceId } }),
      this.prisma.deliveryIssue.groupBy({
        by: ['channel', 'scope', 'code'],
        where: { workspaceId, createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } },
        _count: { _all: true },
        orderBy: { _count: { code: 'desc' } },
      }),
      this.prisma.deliveryIssue.findMany({
        where: { workspaceId },
        orderBy: { createdAt: 'desc' },
        take: 15,
        select: { channel: true, scope: true, code: true, message: true, createdAt: true, eventId: true },
      }),
    ]);
    return {
      email: this.view(rows.find(row => row.channel === 'EMAIL')),
      whatsapp: this.view(rows.find(row => row.channel === 'WHATSAPP')),
      platformEmailAvailable: !!this.config.get('RESEND_API_KEY'),
      issues: issues.map(item => ({ channel: item.channel, scope: item.scope, code: item.code, count: item._count._all })),
      recentIssues: recent,
    };
  }

  /** Lo que ve el cliente de un canal: nunca la credencial, solo sus últimos caracteres. */
  private view(row: ChannelRow | undefined | null) {
    if (!row) return null;
    return {
      channel: row.channel,
      status: row.status,
      secretHint: row.secretHint,
      config: row.config,
      lastCheckedAt: row.lastCheckedAt,
      error: row.lastErrorCode ? { code: row.lastErrorCode, message: row.lastErrorMessage } : null,
      updatedAt: row.updatedAt,
    };
  }

  // ── Correo (Resend del cliente) ───────────────────────────────────────────

  async connectEmail(workspaceId: string, dto: ConnectEmailDto, userId: string) {
    await this.workspaces.assertAccess(workspaceId, userId, MANAGERS);
    const domain = dto.fromEmail.split('@')[1]?.toLowerCase();
    if (!domain) this.reject('EMAIL_FROM_INVALID', 'El remitente no es un correo válido.');
    if (/(^|\.)resend\.dev$/.test(domain)) {
      this.reject(
        'EMAIL_FROM_TEST_DOMAIN',
        'El remitente de pruebas de Resend (resend.dev) solo puede enviar a tu propio correo: no sirve para avisar a los corredores.',
        'Verifica un dominio tuyo en Resend y usa un remitente de ese dominio, por ejemplo fotos@tudominio.com.',
        'https://resend.com/domains',
      );
    }

    const client = new ResendClient(dto.apiKey);
    const listed = await this.run(() => client.listDomains());

    let domainStatus: EmailChannelConfig['domainStatus'] = 'unknown';
    let domainId: string | null = null;
    if (listed.kind === 'OK') {
      const match = listed.domains.find(item => item.name === domain);
      if (!match) {
        const names = listed.domains.map(item => item.name).join(', ');
        this.reject(
          'EMAIL_DOMAIN_NOT_FOUND',
          `El dominio ${domain} no está en tu cuenta de Resend${names ? ` (tienes: ${names})` : ''}.`,
          'Añade el dominio en Resend → Domains y vuelve aquí, o usa un remitente de uno de tus dominios.',
          'https://resend.com/domains',
        );
      }
      domainId = match.id;
      domainStatus = match.status === 'verified' ? 'verified' : 'pending';
    }

    const config: EmailChannelConfig = {
      fromEmail: dto.fromEmail, fromName: dto.fromName ?? null, replyTo: dto.replyTo ?? null,
      domain, domainId, domainStatus, fallbackToPlatform: false, testedAt: null,
    };
    // Con dominio verificado ya puede enviar. Si la clave solo envía (no lista dominios) o el
    // dominio está pendiente, hasta que no salga un correo de prueba no se da por bueno.
    const status: ChannelStatus = domainStatus === 'verified' ? 'ACTIVE' : 'PENDING';
    const row = await this.save(workspaceId, 'EMAIL', status, config as unknown as Prisma.InputJsonValue, dto.apiKey);
    if (status === 'ACTIVE') await this.resume(workspaceId);
    return this.view(row);
  }

  /** Vuelve a comprobar el dominio (y pide a Resend que relea los DNS). */
  async verifyEmail(workspaceId: string, userId: string) {
    await this.workspaces.assertAccess(workspaceId, userId, MANAGERS);
    const row = await this.require(workspaceId, 'EMAIL');
    const config = row.config as unknown as EmailChannelConfig;
    const client = new ResendClient(this.box.decrypt(row.secretEnc));

    let listed;
    try {
      listed = await client.listDomains();
    } catch (error) {
      return this.failed(row, error);
    }
    if (listed.kind === 'RESTRICTED') {
      this.reject('EMAIL_NEEDS_TEST', 'Tu clave solo permite enviar, así que no podemos consultar el estado del dominio.', 'Envía un correo de prueba: si llega, el dominio está bien.');
    }
    const match = listed.domains.find(item => item.name === config.domain);
    if (!match) {
      this.reject('EMAIL_DOMAIN_NOT_FOUND', `El dominio ${config.domain} ya no está en tu cuenta de Resend.`, 'Añádelo de nuevo en Resend → Domains.', 'https://resend.com/domains');
    }
    if (match.status !== 'verified') await client.verifyDomain(match.id).catch(() => undefined);
    const fresh = match.status === 'verified' ? match : await client.getDomain(match.id).catch(() => match);
    const verified = fresh.status === 'verified';
    const next: EmailChannelConfig = { ...config, domainId: match.id, domainStatus: verified ? 'verified' : 'pending' };
    const updated = await this.prisma.workspaceChannel.update({
      where: { id: row.id },
      data: {
        config: next as unknown as Prisma.InputJsonValue,
        status: verified ? 'ACTIVE' : (row.status === 'ERROR' ? 'ERROR' : 'PENDING'),
        lastCheckedAt: new Date(),
        ...(verified ? { lastErrorCode: null, lastErrorMessage: null } : {}),
      },
    });
    if (verified) await this.resume(workspaceId);
    return this.view(updated);
  }

  async updateEmailSettings(workspaceId: string, dto: UpdateEmailSettingsDto, userId: string) {
    await this.workspaces.assertAccess(workspaceId, userId, MANAGERS);
    const row = await this.require(workspaceId, 'EMAIL');
    const config = row.config as unknown as EmailChannelConfig;
    const next: EmailChannelConfig = {
      ...config,
      ...(dto.fallbackToPlatform !== undefined ? { fallbackToPlatform: dto.fallbackToPlatform } : {}),
      ...(dto.fromName !== undefined ? { fromName: dto.fromName } : {}),
      ...(dto.replyTo !== undefined ? { replyTo: dto.replyTo } : {}),
    };
    return this.view(await this.prisma.workspaceChannel.update({ where: { id: row.id }, data: { config: next as unknown as Prisma.InputJsonValue } }));
  }

  async testEmail(workspaceId: string, to: string, userId: string) {
    await this.workspaces.assertAccess(workspaceId, userId, MANAGERS);
    const row = await this.require(workspaceId, 'EMAIL');
    const config = row.config as unknown as EmailChannelConfig;
    const client = new ResendClient(this.box.decrypt(row.secretEnc));
    try {
      await client.send({
        from: formatFrom(config.fromEmail, config.fromName),
        to,
        replyTo: config.replyTo || undefined,
        subject: 'Prueba de avisos de fotos',
        html: `<p>Este es un correo de prueba enviado desde tu cuenta de Resend con LucilaMon.</p><p>Si lo estás leyendo, tus avisos a corredores saldrán con este remitente: <strong>${this.escape(formatFrom(config.fromEmail, config.fromName))}</strong>.</p>`,
      });
    } catch (error) {
      return this.failed(row, error);
    }
    const next: EmailChannelConfig = { ...config, testedAt: nowIso(), domainStatus: config.domainStatus === 'unknown' ? 'verified' : config.domainStatus };
    const updated = await this.prisma.workspaceChannel.update({
      where: { id: row.id },
      data: { status: 'ACTIVE', config: next as unknown as Prisma.InputJsonValue, lastCheckedAt: new Date(), lastErrorCode: null, lastErrorMessage: null },
    });
    await this.resume(workspaceId);
    return this.view(updated);
  }

  // ── WhatsApp Business del cliente ─────────────────────────────────────────

  async connectWhatsApp(workspaceId: string, dto: ConnectWhatsAppDto, userId: string) {
    await this.workspaces.assertAccess(workspaceId, userId, MANAGERS);
    const client = new WhatsAppClient(dto.accessToken);

    const account = await this.run(() => client.getAccount(dto.wabaId));
    const phones = await this.run(() => client.listPhones(dto.wabaId));
    const phone = phones.find(item => item.id === dto.phoneId);
    if (!phone) {
      const list = phones.map(item => `${item.displayPhoneNumber} (ID ${item.id})`).join('; ');
      this.reject(
        'WA_PHONE_NOT_IN_ACCOUNT',
        `Ese ID de número no pertenece a la cuenta${account.name ? ` «${account.name}»` : ''}.${list ? ` Números de la cuenta: ${list}.` : ' La cuenta no tiene números registrados.'}`,
        'Copia el «ID del número de teléfono» (no el número ni el ID de la cuenta) desde WhatsApp Manager → Herramientas de API.',
        'https://business.facebook.com/latest/whatsapp_manager/phone_numbers',
      );
    }

    const warnings: string[] = [];
    if (phone.platformType && phone.platformType !== 'CLOUD_API') warnings.push('Este número no figura como registrado en la Cloud API: si los envíos fallan, completa el registro del número en WhatsApp Manager.');
    if (phone.nameStatus && !['APPROVED', 'AVAILABLE_WITHOUT_REVIEW'].includes(phone.nameStatus)) warnings.push(`El nombre visible del perfil está en estado «${phone.nameStatus}»: Meta puede limitar el envío hasta aprobarlo.`);
    if (phone.qualityRating === 'RED') warnings.push('La calidad del número está en rojo: Meta puede bloquear los envíos.');
    if (phone.messagingLimitTier === 'TIER_250') warnings.push('Tu número está en el nivel de 250 conversaciones nuevas cada 24 horas. Meta lo sube al verificar tu negocio; mientras tanto, los avisos que excedan el límite saldrán al día siguiente.');
    if (account.reviewStatus && account.reviewStatus !== 'APPROVED') warnings.push(`La cuenta de WhatsApp Business está en revisión de Meta («${account.reviewStatus}»): puede no poder enviar todavía.`);
    if (phone.status && !['CONNECTED', 'AVAILABLE_WITHOUT_REVIEW'].includes(phone.status)) warnings.push(`El número figura como «${phone.status}» en Meta.`);

    const previous = await this.prisma.workspaceChannel.findUnique({ where: { workspaceId_channel: { workspaceId, channel: 'WHATSAPP' } } });
    const old = previous?.config as unknown as WhatsAppChannelConfig | undefined;
    const same = !!old && old.wabaId === dto.wabaId && old.phoneId === dto.phoneId;
    const config: WhatsAppChannelConfig = {
      phoneId: dto.phoneId, wabaId: dto.wabaId, displayPhone: phone.displayPhoneNumber, verifiedName: phone.verifiedName,
      qualityRating: phone.qualityRating, messagingLimitTier: phone.messagingLimitTier, nameStatus: phone.nameStatus,
      platformType: phone.platformType, accountName: account.name, accountReviewStatus: account.reviewStatus,
      warnings,
      // Si cambia el número o la cuenta, la prueba y las plantillas ya no valen.
      templates: same ? old!.templates : {},
      testSentAt: same ? old!.testSentAt : null,
      testConfirmedAt: same ? old!.testConfirmedAt : null,
    };
    const status = whatsappStatusFor(config);
    await this.save(workspaceId, 'WHATSAPP', status, config as unknown as Prisma.InputJsonValue, dto.accessToken);
    // Si ya había plantillas en su cuenta, se recogen.
    return this.refreshTemplates(workspaceId, userId, { silent: true });
  }

  /**
   * Crea las plantillas en la cuenta del cliente y las manda a revisión de Meta.
   * Meta responde en minutos u horas; hasta entonces el canal queda pendiente.
   */
  async submitTemplates(workspaceId: string, userId: string) {
    await this.workspaces.assertAccess(workspaceId, userId, MANAGERS);
    const row = await this.require(workspaceId, 'WHATSAPP');
    const config = row.config as unknown as WhatsAppChannelConfig;
    const client = new WhatsAppClient(this.box.decrypt(row.secretEnc));

    const existing = await this.run(() => client.listTemplates(config.wabaId, TEMPLATE_BASE_NAME));
    const versionOf = (name: string) => Number(/_v(\d+)$/.exec(name)?.[1] ?? 0);
    const templates = { ...config.templates };
    const problems: string[] = [];

    for (const locale of TEMPLATE_LOCALES) {
      const ofLocale = existing.filter(item => item.language === locale).sort((a, b) => versionOf(b.name) - versionOf(a.name));
      const latest = ofLocale[0];
      // Ya hay una viva o en revisión: no se duplica.
      if (latest && ['APPROVED', 'PENDING', 'IN_APPEAL', 'PAUSED'].includes(latest.status)) {
        templates[locale] = this.templateState(latest, versionOf(latest.name), templates[locale]);
        continue;
      }
      const version = Math.max(0, ...existing.map(item => versionOf(item.name))) + 1;
      try {
        const created = await client.createTemplate(config.wabaId, templateCreationPayload(locale, version));
        templates[locale] = {
          id: created.id, name: templateName(version), language: locale, version, status: created.status, category: created.category,
          rejectedReason: null, submittedAt: nowIso(), checkedAt: nowIso(),
        };
      } catch (error) {
        if (!(error instanceof ChannelSendError)) throw error;
        problems.push(`${locale === 'es' ? 'Español' : 'Inglés'}: ${error.detail.message}${error.detail.action ? ` ${error.detail.action}` : ''}`);
      }
    }

    const next: WhatsAppChannelConfig = { ...config, templates };
    const updated = await this.prisma.workspaceChannel.update({
      where: { id: row.id },
      data: { config: next as unknown as Prisma.InputJsonValue, status: row.status === 'ERROR' ? 'ERROR' : whatsappStatusFor(next), lastCheckedAt: new Date() },
    });
    if (problems.length === TEMPLATE_LOCALES.length) {
      this.reject('WA_TEMPLATE_SUBMIT_FAILED', `Meta no aceptó las plantillas. ${problems.join(' ')}`, undefined, 'https://business.facebook.com/latest/whatsapp_manager/message_templates');
    }
    return { channel: this.view(updated), problems };
  }

  /** Consulta a Meta cómo van las plantillas. `silent` evita fallar al conectar por un error de lectura. */
  async refreshTemplates(workspaceId: string, userId: string | null, options: { silent?: boolean } = {}) {
    if (userId) await this.workspaces.assertAccess(workspaceId, userId, MANAGERS);
    const row = await this.require(workspaceId, 'WHATSAPP');
    const config = row.config as unknown as WhatsAppChannelConfig;
    const client = new WhatsAppClient(this.box.decrypt(row.secretEnc));

    let listed;
    try {
      listed = await client.listTemplates(config.wabaId, TEMPLATE_BASE_NAME);
    } catch (error) {
      if (options.silent) return this.view(row);
      return this.failed(row, error);
    }

    const versionOf = (name: string) => Number(/_v(\d+)$/.exec(name)?.[1] ?? 0);
    const templates = { ...config.templates };
    const changes: Array<{ locale: TemplateLocale; from?: string; to: string; reason?: string | null; category?: string | null }> = [];
    for (const locale of TEMPLATE_LOCALES) {
      const latest = listed.filter(item => item.language === locale).sort((a, b) => versionOf(b.name) - versionOf(a.name))[0];
      if (!latest) continue;
      const before = templates[locale];
      const after = this.templateState(latest, versionOf(latest.name), before);
      templates[locale] = after;
      if (!before || before.status !== after.status || before.category !== after.category) {
        changes.push({ locale, from: before?.status, to: after.status, reason: after.rejectedReason, category: after.category });
      }
    }

    const next: WhatsAppChannelConfig = { ...config, templates };
    // Una plantilla pausada o desactivada pausa el canal; al aprobarse otra, se reanuda.
    const approved = approvedTemplates(next);
    let status: ChannelStatus = row.status === 'ERROR' && approved.length === 0 ? 'ERROR' : whatsappStatusFor(next);
    let errorCode: string | null | undefined = undefined;
    let errorMessage: string | null | undefined = undefined;
    if (!approved.length) {
      const bad = Object.values(templates).find(item => item && ['PAUSED', 'DISABLED', 'REJECTED'].includes(item.status));
      if (bad && ['PAUSED', 'DISABLED'].includes(bad.status) && row.status !== 'PENDING') {
        status = 'ERROR';
        errorCode = bad.status === 'PAUSED' ? 'WA_TEMPLATE_PAUSED' : 'WA_TEMPLATE_DISABLED';
        errorMessage = 'Meta pausó o desactivó tu plantilla por baja calidad. Envía una versión nueva a revisión desde LucilaMon.';
      }
    } else if (row.status === 'ERROR' && row.lastErrorCode?.startsWith('WA_TEMPLATE')) {
      errorCode = null; errorMessage = null;
    }

    const updated = await this.prisma.workspaceChannel.update({
      where: { id: row.id },
      data: {
        config: next as unknown as Prisma.InputJsonValue, status, lastCheckedAt: new Date(),
        ...(errorCode !== undefined ? { lastErrorCode: errorCode, lastErrorMessage: errorMessage } : {}),
      },
    });
    if (status === 'ACTIVE' && row.status !== 'ACTIVE') await this.resume(workspaceId);
    return Object.assign(this.view(updated)!, { changes });
  }

  /** Manda un mensaje real al teléfono del cliente para comprobar cuenta, plantilla y facturación. */
  async testWhatsApp(workspaceId: string, input: { phone: string; country?: string }, userId: string) {
    await this.workspaces.assertAccess(workspaceId, userId, MANAGERS);
    const row = await this.require(workspaceId, 'WHATSAPP');
    const config = row.config as unknown as WhatsAppChannelConfig;
    const approved = approvedTemplates(config);
    if (!approved.length) {
      this.reject('WA_NO_APPROVED_TEMPLATE', 'Todavía no hay una plantilla aprobada por Meta, así que no se puede enviar una prueba.', 'Envía las plantillas a revisión y espera a que Meta las apruebe.');
    }
    const phone = normalizePhone(input.phone, input.country);
    if (!phone) this.reject('PHONE_INVALID', 'Ese teléfono no es válido. Escríbelo con el prefijo del país.');
    const template = config.templates[approved[0]]!;
    const client = new WhatsAppClient(this.box.decrypt(row.secretEnc));
    const frontend = this.config.get<string>('FRONTEND_URL', 'http://localhost:3000').replace(/\/$/, '');
    try {
      await client.sendTemplate({
        phoneId: config.phoneId, to: phone.e164, name: template.name, language: template.language,
        params: ['LucilaMon', 'Mensaje de prueba', '3', cleanTemplateParam(`${frontend}/`, frontend, 200)],
      });
    } catch (error) {
      return this.failed(row, error);
    }
    const next: WhatsAppChannelConfig = { ...config, testSentAt: nowIso(), testConfirmedAt: null };
    const updated = await this.prisma.workspaceChannel.update({
      where: { id: row.id },
      data: { config: next as unknown as Prisma.InputJsonValue, lastCheckedAt: new Date(), ...(row.status === 'ERROR' ? {} : { status: 'PENDING' }) },
    });
    return this.view(updated);
  }

  /**
   * Meta acepta el mensaje antes de entregarlo: un fallo de pago o de entrega
   * puede llegar después. Por eso el canal solo se activa cuando el cliente
   * confirma que el mensaje de prueba le llegó.
   */
  async confirmWhatsAppTest(workspaceId: string, worked: boolean, userId: string) {
    await this.workspaces.assertAccess(workspaceId, userId, MANAGERS);
    const row = await this.require(workspaceId, 'WHATSAPP');
    const config = row.config as unknown as WhatsAppChannelConfig;
    if (!worked) {
      const next: WhatsAppChannelConfig = { ...config, testSentAt: null, testConfirmedAt: null };
      const updated = await this.prisma.workspaceChannel.update({ where: { id: row.id }, data: { config: next as unknown as Prisma.InputJsonValue, status: 'PENDING' } });
      return {
        channel: this.view(updated),
        checklist: [
          'Que el teléfono tenga WhatsApp y haya aceptado las condiciones de WhatsApp.',
          'Que tu cuenta de WhatsApp Business tenga un método de pago válido (Meta Business Suite → Facturación y pagos). Sin él, Meta acepta el mensaje pero no lo entrega.',
          'Que la plantilla esté «Aprobada» y no pausada en WhatsApp Manager.',
          'Si tu número es el de prueba de Meta, solo escribe a los teléfonos que añadiste a su lista de destinatarios.',
          'Revisa el estado del número y los avisos de calidad en WhatsApp Manager.',
        ],
      };
    }
    if (!config.testSentAt) this.reject('WA_NO_TEST', 'Primero envía el mensaje de prueba.');
    const next: WhatsAppChannelConfig = { ...config, testConfirmedAt: nowIso() };
    const status = whatsappStatusFor(next);
    const updated = await this.prisma.workspaceChannel.update({
      where: { id: row.id },
      data: { config: next as unknown as Prisma.InputJsonValue, status, lastErrorCode: null, lastErrorMessage: null },
    });
    if (status === 'ACTIVE') await this.resume(workspaceId);
    return { channel: this.view(updated), checklist: [] as string[] };
  }

  // ── Común ─────────────────────────────────────────────────────────────────

  async disconnect(workspaceId: string, channel: ChannelKind, userId: string) {
    await this.workspaces.assertAccess(workspaceId, userId, MANAGERS);
    await this.prisma.workspaceChannel.deleteMany({ where: { workspaceId, channel } });
    return { disconnected: true };
  }

  /** Vuelve a programar los avisos que quedaron esperando por un canal pausado. */
  async retry(workspaceId: string, userId: string) {
    await this.workspaces.assertAccess(workspaceId, userId, MANAGERS);
    return { scheduled: await this.scheduler.scheduleForWorkspace(workspaceId) };
  }

  /** Cron: revisa las plantillas que siguen pendientes y avisa al cliente cuando Meta decide. */
  async syncPendingTemplates(): Promise<number> {
    const rows = await this.prisma.workspaceChannel.findMany({ where: { channel: 'WHATSAPP', status: { in: ['PENDING', 'ACTIVE'] } } });
    let changed = 0;
    for (const row of rows) {
      const config = row.config as unknown as WhatsAppChannelConfig;
      const pending = Object.values(config.templates || {}).some(item => item?.status === 'PENDING' || item?.status === 'IN_APPEAL');
      if (!pending) continue;
      try {
        const result: any = await this.refreshTemplates(row.workspaceId, null);
        if (result?.changes?.length) {
          changed += 1;
          await this.notifyTemplateChanges(row.workspaceId, result.changes, result.status);
        }
      } catch (error) {
        this.logger.warn(`No se pudieron revisar las plantillas del espacio ${row.workspaceId}: ${error instanceof Error ? error.message : error}`);
      }
    }
    return changed;
  }

  // ── Interno ───────────────────────────────────────────────────────────────

  private async notifyTemplateChanges(
    workspaceId: string,
    changes: Array<{ locale: TemplateLocale; to: string; reason?: string | null; category?: string | null }>,
    status: string,
  ) {
    const who = await this.health.alertRecipient(workspaceId);
    if (!who) return;
    const lines = changes.map(change => {
      const language = change.locale === 'es' ? 'español' : 'inglés';
      if (change.to === 'APPROVED') {
        const marketing = change.category === 'MARKETING'
          ? ' Ojo: Meta la clasificó como «Marketing», que cuesta más por mensaje que «Utilidad».'
          : '';
        return `✅ La plantilla en ${language} fue <strong>aprobada</strong>.${marketing}`;
      }
      if (change.to === 'REJECTED') return `❌ La plantilla en ${language} fue <strong>rechazada</strong>. ${this.escape(rejectionReasonText(change.reason ?? null) ?? '')} Entra a LucilaMon y envía una versión nueva.`;
      return `ℹ️ La plantilla en ${language} cambió a <strong>${this.escape(change.to)}</strong>.`;
    });
    const next = status === 'PENDING'
      ? '<p>Falta un último paso: envía el mensaje de prueba y confirma que te llegó. Así comprobamos tu facturación de WhatsApp.</p>'
      : '';
    const frontend = this.config.get<string>('FRONTEND_URL', 'http://localhost:3000').replace(/\/$/, '');
    await this.mailer.send({
      to: who.email,
      subject: `WhatsApp de ${who.workspaceName}: novedades de tus plantillas`,
      html: `<div style="font-family:Arial,sans-serif;max-width:560px"><h2>Novedades de tus plantillas de WhatsApp</h2><p>${lines.join('</p><p>')}</p>${next}<p><a href="${this.escape(frontend)}/dashboard">Abrir LucilaMon</a></p></div>`,
    });
  }

  private templateState(info: { id: string; name: string; language: string; status: string; category: string; rejectedReason: string | null }, version: number, previous?: WhatsAppTemplateState): WhatsAppTemplateState {
    return {
      id: info.id, name: info.name, language: info.language, version, status: info.status, category: info.category,
      rejectedReason: info.rejectedReason, submittedAt: previous?.submittedAt ?? null, checkedAt: nowIso(),
    };
  }

  private async save(workspaceId: string, channel: ChannelKind, status: ChannelStatus, config: Prisma.InputJsonValue, secret: string) {
    const data = {
      status, config, secretEnc: this.box.encrypt(secret), secretHint: SecretBox.hint(secret),
      lastCheckedAt: new Date(), lastErrorCode: null, lastErrorMessage: null, lastAlertAt: null, lastAlertCode: null,
    };
    return this.prisma.workspaceChannel.upsert({
      where: { workspaceId_channel: { workspaceId, channel } },
      update: data,
      create: { workspaceId, channel, ...data },
    });
  }

  private async require(workspaceId: string, channel: ChannelKind) {
    const row = await this.prisma.workspaceChannel.findUnique({ where: { workspaceId_channel: { workspaceId, channel } } });
    if (!row) throw new NotFoundException(`${channel === 'EMAIL' ? 'El correo' : 'WhatsApp'} no está conectado en este espacio`);
    return row;
  }

  /** Reanuda lo que esperaba a que el canal volviera a funcionar. */
  private async resume(workspaceId: string) {
    await this.scheduler.scheduleForWorkspace(workspaceId).catch(error =>
      this.logger.warn(`No se pudieron reprogramar los avisos: ${error instanceof Error ? error.message : error}`),
    );
  }

  /** Un fallo en una operación del cliente: se guarda en el canal y se explica con qué hacer. */
  private async failed(row: ChannelRow, error: unknown): Promise<never> {
    if (error instanceof ChannelSendError) {
      const detail = error.detail;
      if (detail.scope === 'ACCOUNT' || detail.scope === 'TEMPLATE') {
        await this.prisma.workspaceChannel.update({
          where: { id: row.id },
          data: {
            status: row.status === 'ACTIVE' ? 'ERROR' : row.status,
            lastErrorCode: detail.code.slice(0, 40),
            lastErrorMessage: [detail.message, detail.action].filter(Boolean).join(' ').slice(0, 600),
            lastCheckedAt: new Date(),
          },
        }).catch(() => undefined);
      }
      this.throwDetail(detail);
    }
    throw error;
  }

  private async run<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof ChannelSendError) this.throwDetail(error.detail);
      throw error;
    }
  }

  private throwDetail(detail: ClassifiedError): never {
    throw new BadRequestException({ code: detail.code, message: detail.message, action: detail.action, helpUrl: detail.helpUrl, provider: detail.raw });
  }

  private reject(code: string, message: string, action?: string, helpUrl?: string): never {
    throw new BadRequestException({ code, message, action, helpUrl });
  }

  private escape(value: string) {
    return value.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] as string));
  }
}
