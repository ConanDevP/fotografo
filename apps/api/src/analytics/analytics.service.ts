import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { WorkspaceRole } from '@prisma/client';
import { PrismaService } from '../common/services/prisma.service';
import { EventsService } from '../events/events.service';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { BillingService } from '../billing/billing.service';
import { UserRole } from '@shared/types';
import { AnalyticsRollupService } from './analytics-rollup.service';

const ZERO_UUID = '00000000-0000-0000-0000-000000000000';
/** Una instantánea más vieja que esto se recalcula al abrir el dashboard. */
const SNAPSHOT_TTL_MS = 6 * 60 * 60 * 1000;
const DAY = 86_400_000;

@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsService,
    private readonly workspaces: WorkspacesService,
    private readonly billing: BillingService,
    private readonly rollup: AnalyticsRollupService,
  ) {}

  // ───────────────────────────────────────────────────────────────────────────
  // Analítica de un evento
  // ───────────────────────────────────────────────────────────────────────────

  async eventAnalytics(eventId: string, userId: string, userRole: UserRole) {
    const event = await this.events.assertCanAccessEvent(eventId, userId, userRole);
    const advanced = await this.isAdvanced(event.workspaceId);

    let snapshot = await this.prisma.eventAnalyticsSnapshot.findUnique({ where: { eventId } });
    const age = snapshot ? Date.now() - snapshot.computedAt.getTime() : Infinity;

    if (!snapshot) {
      // Sin instantánea todavía: merece la pena esperar a la primera.
      await this.rollup.computeEventSnapshot(eventId).catch(error =>
        this.logger.warn(`No se pudo calcular la instantánea de ${eventId}: ${error?.message ?? error}`),
      );
      snapshot = await this.prisma.eventAnalyticsSnapshot.findUnique({ where: { eventId } });
    } else if (age > SNAPSHOT_TTL_MS) {
      // Ya hay datos: se sirven al momento y el recálculo va en segundo plano,
      // para que un evento grande no bloquee la carga del panel.
      void this.rollup.computeEventSnapshot(eventId).catch(error =>
        this.logger.warn(`Recalculo en segundo plano de ${eventId} falló: ${error?.message ?? error}`),
      );
    }

    if (!snapshot) {
      return {
        event: this.eventHeader(event),
        computedAt: null,
        advanced,
        empty: true,
        message: 'Todavía no hay datos suficientes para este evento.',
      };
    }

    const s = snapshot;
    const searches = s.bibSearches + s.faceSearches;

    const funnel = this.buildFunnel([
      { step: 'Vistas del evento', count: s.eventViews },
      { step: 'Búsquedas', count: searches },
      { step: 'Añadir al carrito', count: s.addToCart },
      { step: 'Checkout iniciado', count: s.checkoutStarted },
      { step: 'Compra / descarga', count: s.purchases + s.freeDownloads },
    ]);

    return {
      event: this.eventHeader(event),
      computedAt: s.computedAt.toISOString(),
      advanced,

      pipeline: {
        totalPhotos: s.totalPhotos,
        processedPhotos: s.processedPhotos,
        photosWithBib: s.photosWithBib,
        photosWithFace: s.photosWithFace,
        photosNoBib: s.photosNoBib,
        distinctBibs: s.distinctBibs,
        distinctInferredBibs: s.distinctInferredBibs,
        ocrHitRatePct: this.pct(s.photosWithBib, s.processedPhotos),
        faceCoveragePct: this.pct(s.photosWithFace, s.processedPhotos),
      },

      coverage: {
        fieldSize: s.fieldSize,
        athletesWithPhotos: s.distinctBibs,
        coveragePct: s.fieldSize ? this.pct(s.distinctBibs, s.fieldSize) : null,
        athletesWhoSearched: s.bibsSearched,
        claimRatePct: this.pct(s.bibsSearched, s.distinctBibs),
        athletesWhoBought: s.bibsWithSale,
        buyerRatePct: this.pct(s.bibsWithSale, s.distinctBibs),
      },

      engagement: {
        eventViews: s.eventViews,
        uniqueVisitors: s.uniqueVisitors,
        photoViews: s.photoViews,
        bibSearches: s.bibSearches,
        faceSearches: s.faceSearches,
        searches,
        noResultSearches: s.noResultSearches,
        discoveryRatePct: this.pct(Math.max(0, searches - s.noResultSearches), searches),
      },

      funnel,

      commerce: {
        grossCents: s.grossCents,
        netPlatformCents: s.netPlatformCents,
        organizerCommissionCents: s.organizerCommissionCents,
        photographerEarningCents: s.photographerEarningCents,
        refundCents: s.refundCents,
        purchases: s.purchases,
        freeDownloads: s.freeDownloads,
        paidDownloads: s.paidDownloads,
        conversionRatePct: this.pct(s.purchases, s.eventViews),
      },

      sponsors: {
        impressions: s.sponsorImpressions,
        clicks: s.sponsorClicks,
        ctrPct: this.pct(s.sponsorClicks, s.sponsorImpressions),
      },

      ...(advanced
        ? {
            dailySeries: s.dailySeries ?? [],
            topCountries: s.topCountries ?? [],
            deviceSplit: s.deviceSplit ?? [],
            channelSplit: s.channelSplit ?? [],
          }
        : {}),
    };
  }

  async recomputeEvent(eventId: string, userId: string, userRole: UserRole) {
    await this.events.assertCanManageEvent(eventId, userId, userRole);
    await this.rollup.computeEventSnapshot(eventId);
    return { recomputed: true };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Resumen de un espacio
  // ───────────────────────────────────────────────────────────────────────────

  async workspaceOverview(workspaceId: string, userId: string, from?: string, to?: string) {
    await this.workspaces.assertAccess(workspaceId, userId, [
      WorkspaceRole.OWNER,
      WorkspaceRole.ADMIN,
      WorkspaceRole.ANALYST,
    ]);
    const advanced = await this.isAdvanced(workspaceId);
    const { start, end } = this.resolveRange(from, to, advanced);

    const [rollupRows, paidAgg, ledgerGroups, events] = await Promise.all([
      this.prisma.metricDailyRollup.findMany({
        where: { workspaceId, eventKey: ZERO_UUID, day: { gte: this.dayFloor(start), lte: end } },
        select: { day: true, metricType: true, count: true, uniqueVisitors: true },
      }),
      this.prisma.order.aggregate({
        where: { status: 'PAID', event: { workspaceId }, createdAt: { gte: start, lte: end } },
        _sum: { amountCents: true },
        _count: { _all: true },
      }),
      this.prisma.ledgerEntry.groupBy({
        by: ['type'],
        where: { workspaceId, createdAt: { gte: start, lte: end } },
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
          analyticsSnapshot: true,
        },
        orderBy: { date: 'desc' },
        take: 12,
      }),
    ]);

    const byType = this.sumByType(rollupRows);
    const ledger = Object.fromEntries(ledgerGroups.map(g => [g.type, Math.abs(g._sum.amountCents ?? 0)]));
    const searches = (byType.BIB_SEARCH ?? 0) + (byType.FACE_SEARCH ?? 0);
    const uniqueVisitors = rollupRows.reduce((acc, r) => acc + (r.uniqueVisitors ?? 0), 0);

    return {
      period: { from: start.toISOString(), to: end.toISOString() },
      advanced,
      totals: {
        uniqueVisitors,
        workspaceViews: byType.WORKSPACE_VIEW ?? 0,
        eventViews: byType.EVENT_VIEW ?? 0,
        photoViews: byType.PHOTO_VIEW ?? 0,
        searches,
        noResultSearches: byType.SEARCH_NO_RESULTS ?? 0,
        addToCart: byType.ADD_TO_CART ?? 0,
        purchases: Math.max(byType.PURCHASE_COMPLETED ?? 0, paidAgg._count._all),
        freeDownloads: byType.FREE_DOWNLOAD ?? 0,
        grossCents: ledger.GROSS_SALE ?? paidAgg._sum.amountCents ?? 0,
        platformNetCents: ledger.PLATFORM_FEE ?? 0,
        conversionRatePct: this.pct(paidAgg._count._all, byType.EVENT_VIEW ?? 0),
        sponsorImpressions: byType.SPONSOR_DOWNLOAD_EXPOSURE ?? 0,
        sponsorClicks: byType.SPONSOR_CLICK ?? 0,
      },
      events: events.map(e => this.eventRow(e)),
      ...(advanced
        ? {
            ledger: Object.fromEntries(ledgerGroups.map(g => [g.type, g._sum.amountCents ?? 0])),
            dailySeries: this.workspaceSeries(rollupRows),
            channelSplit: this.mergeSplit(events, 'channelSplit', 'channel'),
            topCountries: this.mergeSplit(events, 'topCountries', 'country'),
          }
        : {}),
    };
  }

  async eventsComparison(workspaceId: string, userId: string) {
    await this.workspaces.assertAccess(workspaceId, userId, [
      WorkspaceRole.OWNER,
      WorkspaceRole.ADMIN,
      WorkspaceRole.ANALYST,
    ]);
    await this.billing.assertPlanAllows(workspaceId, 'allowsAdvancedMetrics');

    const events = await this.prisma.event.findMany({
      where: { workspaceId, deletedAt: null },
      select: {
        id: true,
        name: true,
        slug: true,
        date: true,
        commerceMode: true,
        analyticsSnapshot: true,
      },
      orderBy: { date: 'desc' },
      take: 50,
    });

    return { events: events.map(e => this.eventRow(e)) };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Helpers
  // ───────────────────────────────────────────────────────────────────────────

  private async isAdvanced(workspaceId: string | null | undefined): Promise<boolean> {
    if (!workspaceId) return false;
    try {
      const { plan, enterprise } = await this.billing.resolveForWorkspace(workspaceId);
      return Boolean(plan.allowsAdvancedMetrics || enterprise?.advancedAnalyticsEnabled);
    } catch {
      return false;
    }
  }

  private resolveRange(from: string | undefined, to: string | undefined, advanced: boolean) {
    const end = advanced && to ? new Date(to) : new Date();
    const start = advanced && from ? new Date(from) : new Date(Date.now() - 30 * DAY);
    if (
      Number.isNaN(start.getTime()) ||
      Number.isNaN(end.getTime()) ||
      start > end ||
      end.getTime() - start.getTime() > 366 * DAY
    ) {
      throw new BadRequestException('Rango de fechas inválido');
    }
    return { start, end };
  }

  private dayFloor(d: Date): Date {
    const copy = new Date(d);
    copy.setUTCHours(0, 0, 0, 0);
    return copy;
  }

  private sumByType(rows: Array<{ metricType: string; count: number }>): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of rows) out[r.metricType] = (out[r.metricType] ?? 0) + r.count;
    return out;
  }

  private workspaceSeries(rows: Array<{ day: Date; metricType: string; count: number }>) {
    const keyByType: Record<string, string> = {
      WORKSPACE_VIEW: 'workspaceViews',
      EVENT_VIEW: 'eventViews',
      PHOTO_VIEW: 'photoViews',
      BIB_SEARCH: 'bibSearches',
      FACE_SEARCH: 'faceSearches',
      ADD_TO_CART: 'addToCart',
      PURCHASE_COMPLETED: 'purchases',
      FREE_DOWNLOAD: 'freeDownloads',
    };
    const byDay = new Map<string, Record<string, number>>();
    for (const r of rows) {
      const key = keyByType[r.metricType];
      if (!key) continue;
      const day = r.day.toISOString().slice(0, 10);
      const bucket = byDay.get(day) ?? {};
      bucket[key] = (bucket[key] ?? 0) + r.count;
      byDay.set(day, bucket);
    }
    return [...byDay.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, values]) => ({ day, ...values }));
  }

  private mergeSplit(
    events: Array<{ analyticsSnapshot: { channelSplit?: any; topCountries?: any } | null }>,
    field: 'channelSplit' | 'topCountries',
    labelKey: 'channel' | 'country',
  ) {
    const totals = new Map<string, number>();
    for (const e of events) {
      const rows: Array<Record<string, any>> = (e.analyticsSnapshot as any)?.[field] ?? [];
      for (const row of rows) {
        const label = String(row[labelKey] ?? 'unknown');
        totals.set(label, (totals.get(label) ?? 0) + Number(row.count ?? 0));
      }
    }
    return [...totals.entries()]
      .map(([label, count]) => ({ [labelKey]: label, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 12);
  }

  private eventHeader(event: { id: string; name: string; slug: string; date: Date }) {
    return { id: event.id, name: event.name, slug: event.slug, date: event.date.toISOString() };
  }

  private eventRow(e: {
    id: string;
    name: string;
    slug: string;
    date: Date;
    commerceMode: string;
    analyticsSnapshot: any | null;
  }) {
    const s = e.analyticsSnapshot;
    return {
      id: e.id,
      name: e.name,
      slug: e.slug,
      date: e.date.toISOString(),
      commerceMode: e.commerceMode,
      hasData: Boolean(s),
      totalPhotos: s?.totalPhotos ?? 0,
      distinctBibs: s?.distinctBibs ?? 0,
      coveragePct: s?.fieldSize ? this.pct(s.distinctBibs, s.fieldSize) : null,
      eventViews: s?.eventViews ?? 0,
      uniqueVisitors: s?.uniqueVisitors ?? 0,
      claimRatePct: s ? this.pct(s.bibsSearched, s.distinctBibs) : null,
      purchases: s?.purchases ?? 0,
      freeDownloads: s?.freeDownloads ?? 0,
      grossCents: s?.grossCents ?? 0,
      conversionRatePct: s ? this.pct(s.purchases, s.eventViews) : null,
      computedAt: s?.computedAt ? new Date(s.computedAt).toISOString() : null,
    };
  }

  private buildFunnel(steps: Array<{ step: string; count: number }>) {
    const top = steps[0]?.count ?? 0;
    return steps.map((s, i) => ({
      step: s.step,
      count: s.count,
      fromPrevPct: i === 0 ? 100 : this.pct(s.count, steps[i - 1].count),
      fromTopPct: this.pct(s.count, top),
    }));
  }

  private pct(n: number, d: number): number | null {
    if (!d || d <= 0) return null;
    return Number(((n / d) * 100).toFixed(1));
  }
}
