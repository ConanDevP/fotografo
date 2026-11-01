import {
  BadRequestException,
  GoneException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomInt } from 'crypto';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../common/services/prisma.service';
import { EventsService } from '../events/events.service';
import { DigestSchedulerService, NOTIFIABLE_PHOTO } from '../common/services/digest-scheduler.service';
import { PartnerWebhooksService } from '../partner-api/partner-webhooks.service';
import { normalizePhone } from '../common/utils/phone';
import { bibMatchesRules } from '../common/utils/bib-rules';
import { ERROR_CODES } from '@shared/constants';
import {
  REGISTRATION_CONSENT_VERSION,
  REGISTRATION_WINDOW_DAYS,
  verifyUnsubscribeToken,
} from '@shared/registration';
import { BibRules, UserRole } from '@shared/types';
import { RegisterRunnerDto } from './dto/register-runner.dto';
import { UpdateRegistrationConfigDto } from './dto/registration-admin.dto';

const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const DAY_MS = 24 * 60 * 60 * 1000;
/** Registros por IP y evento en 10 minutos. Holgado: una meta con wifi compartida tiene cientos. */
const IP_WINDOW_LIMIT = 60;

@Injectable()
export class RegistrationsService {
  private readonly logger = new Logger(RegistrationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly events: EventsService,
    private readonly scheduler: DigestSchedulerService,
    @Optional() private readonly webhooks?: PartnerWebhooksService,
  ) {}

  // ── Público ───────────────────────────────────────────────────────────────

  async getPublic(code: string, countryHint?: string) {
    const event = await this.findOpenEvent(code);
    return {
      name: event.name,
      slug: event.slug,
      date: event.date,
      location: event.location,
      imageUrl: event.imageUrl,
      workspace: event.workspace ? { slug: event.workspace.slug, name: event.workspace.name } : null,
      defaultCountry: event.countryCode || this.cleanCountry(countryHint) || null,
      whatsappEnabled: this.whatsappEnabled(),
      turnstileSiteKey: this.config.get<string>('TURNSTILE_SITE_KEY') || null,
      consentVersion: REGISTRATION_CONSENT_VERSION,
    };
  }

  async register(code: string, dto: RegisterRunnerDto, ip: string) {
    // Los robots rellenan todo lo que ven. Se les responde igual que a una
    // persona para que no sepan que fallaron.
    if (dto.website) return { registered: true, channels: [] as string[], hasPhotos: false };

    const event = await this.findOpenEvent(code);
    await this.verifyTurnstile(dto.turnstileToken, ip);

    if (!bibMatchesRules(dto.bib, event.bibRules as BibRules | null)) {
      throw new BadRequestException({
        code: ERROR_CODES.INVALID_BIB_FORMAT,
        message: 'Ese dorsal no existe en este evento',
      });
    }

    const emailChannel = !!dto.email && dto.emailConsent === true;
    if (dto.email && dto.emailConsent !== true) {
      throw new BadRequestException({ code: ERROR_CODES.VALIDATION_ERROR, message: 'Acepta recibir avisos por correo o quita el correo' });
    }

    let phone: { e164: string; country: string } | null = null;
    if (dto.phone) {
      // Sin canal de WhatsApp configurado el formulario ni siquiera pide el teléfono:
      // guardarlo aquí daría a entender que va a llegar un aviso que no va a salir.
      if (!this.whatsappEnabled()) {
        throw new BadRequestException({ code: ERROR_CODES.VALIDATION_ERROR, message: 'Los avisos por WhatsApp no están disponibles todavía. Déjanos un correo.' });
      }
      if (dto.whatsappConsent !== true) {
        throw new BadRequestException({ code: ERROR_CODES.VALIDATION_ERROR, message: 'Acepta recibir avisos por WhatsApp o quita el teléfono' });
      }
      phone = normalizePhone(dto.phone, dto.phoneCountry || event.countryCode);
      if (!phone) {
        throw new BadRequestException({ code: ERROR_CODES.VALIDATION_ERROR, message: 'El teléfono no es válido para ese país' });
      }
    }
    const whatsappChannel = !!phone;
    if (!emailChannel && !whatsappChannel) {
      throw new BadRequestException({ code: ERROR_CODES.VALIDATION_ERROR, message: 'Deja un correo o un teléfono para avisarte' });
    }

    const ipHash = this.hashIp(ip);
    const recent = await this.prisma.bibSubscription.count({
      where: { eventId: event.id, ipHash, createdAt: { gte: new Date(Date.now() - 10 * 60 * 1000) } },
    });
    if (recent >= IP_WINDOW_LIMIT) {
      throw new HttpException(
        { code: 'TOO_MANY_REQUESTS', message: 'Demasiados registros desde esta conexión. Intenta en unos minutos.' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const now = new Date();
    const data = {
      name: dto.name || undefined,
      locale: dto.locale || 'es',
      source: 'QR',
      status: 'ACTIVE',
      unsubscribedAt: null,
      consentTextVersion: REGISTRATION_CONSENT_VERSION,
      ipHash,
      ...(emailChannel ? { email: dto.email, emailConsentAt: now } : {}),
      ...(phone ? { phone: phone.e164, phoneCountry: phone.country, whatsappConsentAt: now } : {}),
    };

    const subscription = await this.upsertSubscription(event.id, dto.bib, dto.email, phone?.e164, data);

    // Si ya hay fotos suyas, el aviso sale en un minuto en vez de esperar a la siguiente.
    await this.scheduler.scheduleForBibs(event.id, [dto.bib], 30_000).catch(error =>
      this.logger.warn(`No se pudo programar el aviso inicial: ${error instanceof Error ? error.message : error}`),
    );

    const hasPhotos = event.isPublished
      ? (await this.prisma.photoBib.count({ where: { eventId: event.id, bib: dto.bib, photo: NOTIFIABLE_PHOTO } })) > 0
      : false;

    const channels = [emailChannel && 'EMAIL', whatsappChannel && 'WHATSAPP'].filter(Boolean) as string[];
    // El webhook no lleva correo ni teléfono: quien lo recibe los consulta con la API y su scope.
    await this.emitWebhook(event.workspaceId, 'runner.registered', {
      eventId: event.id, registrationId: subscription.id, bib: dto.bib, channels, source: 'QR',
    });

    return { registered: true, channels, hasPhotos, id: subscription.id };
  }

  async unsubscribeInfo(token: string) {
    const subscription = await this.subscriptionFromToken(token);
    return { eventName: subscription.event.name, bib: subscription.bib, unsubscribed: subscription.status === 'UNSUBSCRIBED' };
  }

  async unsubscribe(token: string) {
    const subscription = await this.subscriptionFromToken(token);
    if (subscription.status !== 'UNSUBSCRIBED') {
      await this.prisma.bibSubscription.update({
        where: { id: subscription.id },
        data: { status: 'UNSUBSCRIBED', unsubscribedAt: new Date() },
      });
      await this.emitWebhook(subscription.event.workspaceId, 'runner.unsubscribed', {
        eventId: subscription.eventId, registrationId: subscription.id, bib: subscription.bib,
      });
    }
    return { unsubscribed: true };
  }

  // ── Panel ─────────────────────────────────────────────────────────────────

  async getConfig(eventId: string, userId: string, role: UserRole) {
    await this.events.assertCanAccessEvent(eventId, userId, role);
    const event = await this.prisma.event.findFirstOrThrow({
      where: { id: eventId, deletedAt: null },
      select: {
        registrationCode: true, registrationEnabled: true, registrationUseCustomDomain: true, countryCode: true, date: true,
        workspace: { select: { customDomain: true, customDomainVerifiedAt: true } },
      },
    });
    const customDomain = this.verifiedDomain(event.workspace);
    const code = event.registrationCode;
    // Si el dominio dejó de estar verificado, el QR vuelve solo a lucilamon.com: mejor eso que un enlace muerto.
    const usingCustomDomain = event.registrationUseCustomDomain && !!customDomain;
    return {
      enabled: event.registrationEnabled,
      code,
      url: code ? this.registrationUrl(code, usingCustomDomain ? customDomain : null) : null,
      platformUrl: code ? this.registrationUrl(code) : null,
      customDomain,
      customDomainUrl: code && customDomain ? this.registrationUrl(code, customDomain) : null,
      useCustomDomain: usingCustomDomain,
      customDomainLapsed: event.registrationUseCustomDomain && !customDomain,
      countryCode: event.countryCode,
      closesAt: new Date(event.date.getTime() + REGISTRATION_WINDOW_DAYS * DAY_MS),
      whatsappEnabled: this.whatsappEnabled(),
      stats: await this.stats(eventId),
    };
  }

  async updateConfig(eventId: string, dto: UpdateRegistrationConfigDto, userId: string, role: UserRole) {
    await this.events.assertCanManageEvent(eventId, userId, role);
    const current = await this.prisma.event.findFirstOrThrow({
      where: { id: eventId, deletedAt: null },
      select: { registrationCode: true, workspace: { select: { customDomain: true, customDomainVerifiedAt: true } } },
    });
    const data: Prisma.EventUpdateInput = {};
    if (dto.enabled !== undefined) data.registrationEnabled = dto.enabled;
    if (dto.countryCode !== undefined) data.countryCode = dto.countryCode;
    if (dto.useCustomDomain !== undefined) {
      if (dto.useCustomDomain && !this.verifiedDomain(current.workspace)) {
        throw new BadRequestException({
          code: ERROR_CODES.VALIDATION_ERROR,
          message: 'Tu espacio no tiene un dominio propio verificado. Conéctalo en la configuración del espacio.',
        });
      }
      data.registrationUseCustomDomain = dto.useCustomDomain;
    }
    if (dto.enabled && !current.registrationCode) data.registrationCode = await this.freshCode();
    if (Object.keys(data).length) await this.prisma.event.update({ where: { id: eventId }, data });
    return this.getConfig(eventId, userId, role);
  }

  async list(eventId: string, query: { search?: string; page?: number; limit?: number }, userId: string, role: UserRole) {
    await this.events.assertCanManageAudienceData(eventId, userId, role);
    const limit = Math.min(Math.max(query.limit || 25, 1), 100);
    const page = Math.max(query.page || 1, 1);
    const search = query.search?.trim();
    const where: Prisma.BibSubscriptionWhereInput = {
      eventId,
      ...(search
        ? {
            OR: [
              { bib: { startsWith: search } },
              { email: { contains: search, mode: 'insensitive' } },
              { name: { contains: search, mode: 'insensitive' } },
              { phone: { contains: search } },
            ],
          }
        : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.bibSubscription.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true, bib: true, name: true, email: true, phone: true, phoneCountry: true, source: true,
          status: true, createdAt: true, lastNotifiedAt: true,
          emailConsentAt: true, whatsappConsentAt: true,
        },
      }),
      this.prisma.bibSubscription.count({ where }),
    ]);
    return { items, total, page, limit };
  }

  async remove(eventId: string, id: string, userId: string, role: UserRole) {
    await this.events.assertCanManageAudienceData(eventId, userId, role);
    const result = await this.prisma.bibSubscription.deleteMany({ where: { id, eventId } });
    if (!result.count) throw new NotFoundException('Registro no encontrado');
    return { deleted: true };
  }

  async exportCsv(eventId: string, userId: string, role: UserRole) {
    await this.events.assertCanManageAudienceData(eventId, userId, role);
    const rows = await this.prisma.bibSubscription.findMany({
      where: { eventId },
      orderBy: { createdAt: 'asc' },
      select: {
        bib: true, name: true, email: true, phone: true, phoneCountry: true, source: true, status: true,
        locale: true, emailConsentAt: true, whatsappConsentAt: true, createdAt: true,
      },
    });
    const header = ['dorsal', 'nombre', 'correo', 'telefono', 'pais', 'origen', 'estado', 'idioma', 'consentimiento_correo', 'consentimiento_whatsapp', 'registrado'];
    const lines = rows.map(row => [
      row.bib, row.name, row.email, row.phone, row.phoneCountry, row.source, row.status, row.locale,
      row.emailConsentAt?.toISOString(), row.whatsappConsentAt?.toISOString(), row.createdAt.toISOString(),
    ].map(cell => this.csvCell(cell)).join(','));
    return `﻿${[header.join(','), ...lines].join('\n')}\n`;
  }

  /** Totales sin datos personales: los puede ver cualquiera con acceso al evento. */
  async stats(eventId: string) {
    const [total, active, withEmail, withPhone, notified] = await Promise.all([
      this.prisma.bibSubscription.count({ where: { eventId } }),
      this.prisma.bibSubscription.count({ where: { eventId, status: 'ACTIVE' } }),
      this.prisma.bibSubscription.count({ where: { eventId, status: 'ACTIVE', email: { not: null } } }),
      this.prisma.bibSubscription.count({ where: { eventId, status: 'ACTIVE', phone: { not: null } } }),
      this.prisma.bibSubscription.count({ where: { eventId, deliveries: { some: {} } } }),
    ]);
    return { total, active, unsubscribed: total - active, withEmail, withPhone, notified };
  }

  // ── Interno ───────────────────────────────────────────────────────────────

  /** `domain` es el dominio propio ya verificado; sin él, la dirección de la plataforma. */
  registrationUrl(code: string, domain?: string | null) {
    const base = domain
      ? `https://${domain}`
      : this.config.get<string>('FRONTEND_URL', 'http://localhost:3000').replace(/\/$/, '');
    return `${base}/r/${code}`;
  }

  private verifiedDomain(workspace?: { customDomain: string | null; customDomainVerifiedAt: Date | null } | null) {
    return workspace?.customDomain && workspace.customDomainVerifiedAt ? workspace.customDomain : null;
  }

  private async findOpenEvent(code: string) {
    if (!/^[a-z0-9]{6,12}$/i.test(code)) throw new NotFoundException('Registro no disponible');
    const event = await this.prisma.event.findFirst({
      where: { registrationCode: code.toLowerCase(), registrationEnabled: true, deletedAt: null },
      include: { workspace: { select: { slug: true, name: true } } },
    });
    if (!event) throw new NotFoundException('Registro no disponible');
    if (Date.now() > event.date.getTime() + REGISTRATION_WINDOW_DAYS * DAY_MS) {
      throw new GoneException({ code: 'REGISTRATION_CLOSED', message: 'El registro de este evento ya cerró' });
    }
    return event;
  }

  /**
   * Una persona puede dejar correo y teléfono en la misma fila. Si ya existía por
   * cualquiera de los dos se completa en vez de duplicar; si existía por separado
   * (una fila con el correo y otra con el teléfono) se unen en una sola.
   * Dos escaneos casi simultáneos chocan con la restricción única: el segundo
   * reintenta y encuentra la fila del primero.
   */
  private async upsertSubscription(
    eventId: string,
    bib: string,
    email: string | undefined,
    phone: string | undefined,
    data: Record<string, unknown>,
  ) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.upsertOnce(eventId, bib, email, phone, data);
      } catch (error) {
        const conflict = error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
        if (!conflict || attempt >= 2) throw error;
      }
    }
  }

  private async upsertOnce(
    eventId: string,
    bib: string,
    email: string | undefined,
    phone: string | undefined,
    data: Record<string, unknown>,
  ) {
    const matches = await this.prisma.bibSubscription.findMany({
      where: { eventId, bib, OR: [...(email ? [{ email }] : []), ...(phone ? [{ phone }] : [])] },
      orderBy: { createdAt: 'asc' },
    });
    if (!matches.length) {
      return this.prisma.bibSubscription.create({ data: { eventId, bib, ...(data as any) } });
    }

    const [survivor, ...duplicates] = matches;
    for (const duplicate of duplicates) {
      // Lo ya avisado a la fila que desaparece no debe volver a avisarse.
      const history = await this.prisma.bibNotificationLog.findMany({
        where: { subscriptionId: duplicate.id },
        select: { photoId: true, channel: true, sentAt: true },
      });
      await this.prisma.$transaction([
        this.prisma.bibNotificationLog.createMany({
          data: history.map(entry => ({ ...entry, subscriptionId: survivor.id })),
          skipDuplicates: true,
        }),
        this.prisma.bibSubscription.delete({ where: { id: duplicate.id } }),
      ]);
    }
    return this.prisma.bibSubscription.update({ where: { id: survivor.id }, data: data as any });
  }

  private async subscriptionFromToken(token: string) {
    const id = token ? verifyUnsubscribeToken(token, this.secret()) : null;
    if (!id) throw new NotFoundException('Enlace no válido');
    const subscription = await this.prisma.bibSubscription.findUnique({
      where: { id },
      include: { event: { select: { name: true, workspaceId: true } } },
    });
    if (!subscription) throw new NotFoundException('Enlace no válido');
    return subscription;
  }

  private async emitWebhook(workspaceId: string | null, type: 'runner.registered' | 'runner.unsubscribed', data: unknown) {
    if (!workspaceId || !this.webhooks) return;
    await this.webhooks.emit(workspaceId, type, data).catch(error =>
      this.logger.warn(`No se pudo registrar el webhook ${type}: ${error instanceof Error ? error.message : error}`),
    );
  }

  private async verifyTurnstile(token: string | undefined, ip: string) {
    const secret = this.config.get<string>('TURNSTILE_SECRET');
    if (!secret) return;
    if (!token) throw new BadRequestException({ code: ERROR_CODES.VALIDATION_ERROR, message: 'Confirma que no eres un robot' });
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret, response: token, remoteip: ip }),
      signal: AbortSignal.timeout(5000),
    }).catch(() => null);
    const result = response?.ok ? ((await response.json().catch(() => null)) as { success?: boolean } | null) : null;
    if (!result?.success) {
      throw new BadRequestException({ code: ERROR_CODES.VALIDATION_ERROR, message: 'No pudimos verificar que eres una persona. Intenta de nuevo.' });
    }
  }

  private async freshCode(): Promise<string> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const code = Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
      const taken = await this.prisma.event.findUnique({ where: { registrationCode: code }, select: { id: true } });
      if (!taken) return code;
    }
    throw new HttpException('No se pudo generar el código', HttpStatus.INTERNAL_SERVER_ERROR);
  }

  whatsappEnabled() {
    return !!(
      this.config.get('WHATSAPP_TOKEN')
      && this.config.get('WHATSAPP_PHONE_ID')
      && this.config.get('WHATSAPP_TEMPLATE_ES')
    );
  }

  private secret() {
    const secret = this.config.get<string>('REGISTRATION_SECRET');
    if (secret) return secret;
    if (this.config.get('NODE_ENV') === 'production') {
      throw new Error('REGISTRATION_SECRET no está configurado');
    }
    return 'dev-registration-secret';
  }

  private hashIp(ip: string) {
    return createHash('sha256').update(`${this.secret()}:${ip}`).digest('hex');
  }

  private cleanCountry(value?: string) {
    return value && /^[A-Za-z]{2}$/.test(value) ? value.toUpperCase() : undefined;
  }

  /** Evita que una celda que empieza por = + - @ se ejecute como fórmula al abrir el CSV. */
  private csvCell(value: unknown) {
    if (value === null || value === undefined) return '';
    let text = String(value);
    // Un teléfono E.164 empieza por "+" y es lo que el contacto necesita tal cual; ya está validado, no puede ser una fórmula.
    if (/^[=+\-@\t\r]/.test(text) && !/^\+\d{6,15}$/.test(text)) text = `'${text}`;
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }
}
