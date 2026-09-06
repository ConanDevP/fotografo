import { createHmac } from 'crypto';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { Prisma, WorkspaceRole } from '@prisma/client';
import { PrismaService } from '../common/services/prisma.service';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { BillingService } from '../billing/billing.service';
import { RecordMetricDto } from './dto/record-metric.dto';

@Injectable()
export class MetricsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly workspaces: WorkspacesService,
    private readonly billing: BillingService,
  ) {}

  async record(dto: RecordMetricDto, req: Request, userId?: string) {
    const publicTypes = new Set([
      'WORKSPACE_VIEW',
      'EVENT_VIEW',
      'PHOTO_VIEW',
      'BIB_SEARCH',
      'FACE_SEARCH',
      'SEARCH_NO_RESULTS',
      'ADD_TO_CART',
      'CHECKOUT_STARTED',
      'SPONSOR_CLICK',
    ]);
    if (!userId && (!publicTypes.has(dto.type) || dto.orderId)) {
      throw new BadRequestException('Este tipo de métrica solo puede registrarlo el servidor');
    }
    if (dto.metadata && JSON.stringify(dto.metadata).length > 10_000) {
      throw new BadRequestException('Los metadatos de la métrica son demasiado grandes');
    }

    let workspaceId = dto.workspaceId;
    let eventId = dto.eventId;
    if (eventId) {
      const event = await this.prisma.event.findUnique({
        where: {
          id: eventId,
          deletedAt: null,
          isPublished: true,
                  },
        select: { workspaceId: true },
      });
      if (!event) throw new NotFoundException('Evento no encontrado');
      if (workspaceId && event.workspaceId !== workspaceId) {
        throw new BadRequestException('El evento no pertenece al espacio indicado');
      }
      workspaceId = event.workspaceId || undefined;
    }

    if (dto.photoId) {
      const photo = await this.prisma.photo.findUnique({
        where: { id: dto.photoId },
        select: {
          eventId: true,
          status: true,
          publicationStatus: true,
          event: { select: { workspaceId: true, isPublished: true, commerceMode: true, deletedAt: true } },
        },
      });
      if (
        !photo ||
        photo.status !== 'PROCESSED' ||
        photo.publicationStatus !== 'APPROVED' ||
        !photo.event.isPublished ||
        photo.event.deletedAt ||
        (eventId && photo.eventId !== eventId)
      ) {
        throw new NotFoundException('Fotografía no encontrada');
      }
      if (workspaceId && photo.event.workspaceId !== workspaceId) {
        throw new BadRequestException('La fotografía no pertenece al espacio indicado');
      }
      eventId = photo.eventId;
      workspaceId = photo.event.workspaceId || undefined;
    }

    if (workspaceId && !eventId) {
      const workspace = await this.prisma.workspace.findUnique({
        where: { id: workspaceId, isPublished: true, deletedAt: null },
        select: { id: true },
      });
      if (!workspace) throw new NotFoundException('Espacio no encontrado');
    }

    if (dto.type === 'SPONSOR_CLICK') {
      const sponsorId = dto.metadata?.sponsorId;
      if (typeof sponsorId !== 'string') throw new BadRequestException('La métrica de sponsor requiere un patrocinador');
      const sponsor = eventId
        ? await this.prisma.eventSponsor.findFirst({
            where: { eventId, sponsorId, status: 'ACTIVE', sponsor: { isActive: true, workspaceId } },
            select: { id: true },
          })
        : await this.prisma.sponsor.findFirst({
            where: { id: sponsorId, workspaceId, isActive: true },
            select: { id: true },
          });
      if (!sponsor) throw new NotFoundException('Patrocinador no encontrado');
    }

    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const userAgent = String(req.headers['user-agent'] || 'unknown');
    const secret = this.config.get('METRICS_HASH_SECRET') || this.config.get('ORDER_ACCESS_SECRET') || 'lucilamon-local-metrics';
    const visitorHash = createHmac('sha256', secret).update(`${ip}|${userAgent}`).digest('hex');
    // Hash rotado por día: cuenta únicos sin retener un identificador estable.
    const daySalt = new Date().toISOString().slice(0, 10);
    const dayVisitorHash = createHmac('sha256', secret)
      .update(`${daySalt}|${ip}|${userAgent}`)
      .digest('hex');

    const ua = userAgent.toLowerCase();
    const isBot = this.looksLikeBot(ua);
    const device = isBot
      ? 'bot'
      : /ipad|tablet|playbook|silk|kindle/.test(ua)
        ? 'tablet'
        : /mobi|android|iphone|ipod|phone|blackberry|iemobile|opera mini/.test(ua)
          ? 'mobile'
          : 'desktop';

    await this.prisma.metricEvent.create({
      data: {
        type: dto.type,
        workspaceId,
        eventId,
        photoId: dto.photoId,
        orderId: dto.orderId,
        userId,
        sessionId: dto.sessionId,
        visitorHash,
        dayVisitorHash,
        channel: this.classifyChannel(dto, req),
        device,
        country: this.readCountry(req),
        isBot,
        isInternal: await this.isInternalView(userId, workspaceId),
        source: dto.source,
        metadata: dto.metadata as any,
      },
    });

    return { recorded: true };
  }

  private looksLikeBot(ua: string): boolean {
    return /bot|crawler|spider|crawling|facebookexternalhit|slurp|bingpreview|headless|lighthouse|pingdom|uptimerobot|monitor|curl\/|wget\/|python-requests|axios\//.test(
      ua,
    );
  }

  private readCountry(req: Request): string | undefined {
    const raw = String(
      req.headers['cf-ipcountry'] ||
        req.headers['x-vercel-ip-country'] ||
        req.headers['x-country-code'] ||
        req.headers['x-geo-country'] ||
        '',
    )
      .toUpperCase()
      .trim();
    return /^[A-Z]{2}$/.test(raw) && raw !== 'XX' && raw !== 'T1' ? raw : undefined;
  }

  /**
   * Hosts propios: se derivan solos de FRONTEND_URL / APP_URL (que ya son
   * obligatorias en producción), y METRICS_SELF_HOSTS añade extras. Así la
   * atribución de canal funciona sin configurar nada.
   */
  private selfHostsCache: string[] | null = null;
  private selfHosts(): string[] {
    if (this.selfHostsCache) return this.selfHostsCache;
    const fromUrl = (name: string) => {
      const value = this.config.get<string>(name);
      if (!value) return '';
      try {
        return new URL(value).hostname.replace(/^www\./, '').toLowerCase();
      } catch {
        return '';
      }
    };
    const extras = String(this.config.get('METRICS_SELF_HOSTS') || '')
      .split(',')
      .map(s => s.trim().toLowerCase())
      .filter(Boolean);
    this.selfHostsCache = [
      ...new Set([fromUrl('FRONTEND_URL'), fromUrl('APP_URL'), fromUrl('PUBLIC_WEB_URL'), ...extras].filter(Boolean)),
    ];
    return this.selfHostsCache;
  }

  /**
   * Canal de atribución: utm_source explícito > patrocinador > dominio de
   * procedencia > `source` del cliente > "direct".
   */
  private classifyChannel(dto: RecordMetricDto, req: Request): string {
    const md = (dto.metadata || {}) as Record<string, unknown>;
    const utm = typeof md.utm_source === 'string' ? md.utm_source.trim().toLowerCase() : '';
    if (utm) return utm.slice(0, 40);
    if (dto.type === 'SPONSOR_CLICK' && typeof md.sponsorId === 'string') return 'sponsor';

    const ref = String(req.headers['referer'] || req.headers['referrer'] || '');
    if (ref) {
      try {
        const host = new URL(ref).hostname.replace(/^www\./, '').toLowerCase();
        const isSelf = this.selfHosts().some(h => host === h || host.endsWith(`.${h}`));
        if (host && !isSelf) return `referral:${host}`.slice(0, 60);
      } catch {
        // Referer ilegible: se ignora.
      }
    }

    if (dto.source) return String(dto.source).trim().toLowerCase().slice(0, 40);
    return 'direct';
  }

  /**
   * Vista de un miembro del propio espacio: no cuenta como audiencia. Cacheado
   * 5 min para no consultar workspace_members en cada evento de métrica.
   */
  private internalCache = new Map<string, { value: boolean; expiresAt: number }>();
  private async isInternalView(userId?: string, workspaceId?: string): Promise<boolean> {
    if (!userId || !workspaceId) return false;
    const key = `${userId}:${workspaceId}`;
    const cached = this.internalCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const member = await this.prisma.workspaceMember.findFirst({
      where: { userId, workspaceId, status: 'ACTIVE' },
      select: { id: true },
    });
    const value = Boolean(member);
    if (this.internalCache.size > 5000) this.internalCache.clear();
    this.internalCache.set(key, { value, expiresAt: Date.now() + 5 * 60 * 1000 });
    return value;
  }

  async overview(workspaceId: string, userId: string, from?: string, to?: string) {
    await this.workspaces.assertAccess(workspaceId, userId, [
      WorkspaceRole.OWNER,
      WorkspaceRole.ADMIN,
      WorkspaceRole.ANALYST,
    ]);
    // Los totales de cabecera los ve todo el mundo: sin ellos el plan gratuito
    // parecería roto. Lo que se paga es el desglose y elegir el periodo.
    const { plan } = await this.billing.resolveForWorkspace(workspaceId);
    const advanced = plan.allowsAdvancedMetrics;

    const start = advanced && from ? new Date(from) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const end = advanced && to ? new Date(to) : new Date();
    if (
      Number.isNaN(start.getTime()) ||
      Number.isNaN(end.getTime()) ||
      start > end ||
      end.getTime() - start.getTime() > 366 * 24 * 60 * 60 * 1000
    ) {
      throw new BadRequestException('Rango de fechas inválido');
    }
    const createdAt = { gte: start, lte: end };

    const [metricGroups, uniqueVisitorRows, paidOrders, revenue, ledger, recentEvents] = await Promise.all([
      this.prisma.metricEvent.groupBy({
        by: ['type'],
        where: { workspaceId, createdAt },
        _count: { _all: true },
      }),
      this.prisma.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
        SELECT COUNT(DISTINCT "visitor_hash")::bigint AS "count"
        FROM "metric_events"
        WHERE "workspace_id" = ${workspaceId}::uuid
          AND "created_at" >= ${start}
          AND "created_at" <= ${end}
          AND "visitor_hash" IS NOT NULL
      `),
      this.prisma.order.count({
        where: { status: 'PAID', event: { workspaceId }, createdAt },
      }),
      this.prisma.order.aggregate({
        where: { status: 'PAID', event: { workspaceId }, createdAt },
        _sum: { amountCents: true },
      }),
      this.prisma.ledgerEntry.groupBy({
        by: ['type'],
        where: { workspaceId, createdAt },
        _sum: { amountCents: true },
      }),
      this.prisma.event.findMany({
        where: { workspaceId, deletedAt: null },
        select: {
          id: true,
          name: true,
          slug: true,
          date: true,
          commerceMode: true,
          totalFreeDownloads: true,
          _count: { select: { photos: true, orders: { where: { status: 'PAID' } }, contributors: true } },
        },
        orderBy: { date: 'desc' },
        take: 10,
      }),
    ]);

    const metrics = Object.fromEntries(metricGroups.map(group => [group.type, group._count._all]));
    const eventViews = metrics.EVENT_VIEW || 0;
    const purchases = metrics.PURCHASE_COMPLETED || paidOrders;

    return {
      period: { from: start.toISOString(), to: end.toISOString() },
      totals: {
        uniqueVisitors: Number(uniqueVisitorRows[0]?.count || 0),
        workspaceViews: metrics.WORKSPACE_VIEW || 0,
        eventViews,
        photoViews: metrics.PHOTO_VIEW || 0,
        searches: (metrics.BIB_SEARCH || 0) + (metrics.FACE_SEARCH || 0),
        noResultSearches: metrics.SEARCH_NO_RESULTS || 0,
        freeDownloads: metrics.FREE_DOWNLOAD || 0,
        paidDownloads: metrics.PAID_DOWNLOAD || 0,
        purchases,
        revenueCents: revenue._sum.amountCents || 0,
        conversionRate: eventViews > 0 ? Number(((purchases / eventViews) * 100).toFixed(2)) : 0,
        sponsorExposures: metrics.SPONSOR_DOWNLOAD_EXPOSURE || 0,
        sponsorClicks: metrics.SPONSOR_CLICK || 0,
      },
      advanced,
      ...(advanced
        ? {
            ledger: Object.fromEntries(ledger.map(entry => [entry.type, entry._sum.amountCents || 0])),
            events: recentEvents,
            rawMetrics: metrics,
          }
        : {}),
    };
  }
}
