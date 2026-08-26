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
    const userAgent = req.headers['user-agent'] || 'unknown';
    const secret = this.config.get('METRICS_HASH_SECRET') || this.config.get('ORDER_ACCESS_SECRET') || 'lucilamon-local-metrics';
    const visitorHash = createHmac('sha256', secret).update(`${ip}|${userAgent}`).digest('hex');

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
        source: dto.source,
        metadata: dto.metadata as any,
      },
    });

    return { recorded: true };
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
