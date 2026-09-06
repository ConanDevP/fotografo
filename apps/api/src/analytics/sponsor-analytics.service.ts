import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { WorkspaceRole } from '@prisma/client';
import { PrismaService } from '../common/services/prisma.service';
import { EventsService } from '../events/events.service';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { BillingService } from '../billing/billing.service';
import { UserRole } from '@shared/types';

const DAY = 86_400_000;

/**
 * Analítica de patrocinadores. Lee `sponsor_daily_rollup` (poblado por el cron de
 * agregación desde los eventos SPONSOR_CLICK / SPONSOR_DOWNLOAD_EXPOSURE). Es un
 * add-on: requiere que el plan del espacio incluya patrocinadores.
 */
@Injectable()
export class SponsorAnalyticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsService,
    private readonly workspaces: WorkspacesService,
    private readonly billing: BillingService,
  ) {}

  async sponsorOverview(
    workspaceId: string,
    sponsorId: string,
    userId: string,
    from?: string,
    to?: string,
  ) {
    await this.workspaces.assertAccess(workspaceId, userId, [
      WorkspaceRole.OWNER,
      WorkspaceRole.ADMIN,
      WorkspaceRole.ANALYST,
    ]);
    await this.billing.assertPlanAllows(workspaceId, 'allowsSponsors');

    const sponsor = await this.prisma.sponsor.findFirst({
      where: { id: sponsorId, workspaceId },
      select: { id: true, name: true, logoUrl: true, websiteUrl: true },
    });
    if (!sponsor) throw new NotFoundException('Patrocinador no encontrado');

    const { start, end } = this.range(from, to);
    const rows = await this.prisma.sponsorDailyRollup.findMany({
      where: { sponsorId, day: { gte: this.dayFloor(start), lte: end } },
      select: { day: true, eventId: true, impressions: true, clicks: true, uniqueReach: true },
      orderBy: { day: 'asc' },
    });

    const impressions = rows.reduce((a, r) => a + r.impressions, 0);
    const clicks = rows.reduce((a, r) => a + r.clicks, 0);
    const uniqueReach = rows.reduce((a, r) => a + r.uniqueReach, 0);

    // Desglose por evento.
    const byEventId = new Map<string, { impressions: number; clicks: number }>();
    for (const r of rows) {
      if (!r.eventId) continue;
      const b = byEventId.get(r.eventId) ?? { impressions: 0, clicks: 0 };
      b.impressions += r.impressions;
      b.clicks += r.clicks;
      byEventId.set(r.eventId, b);
    }
    const eventNames = byEventId.size
      ? await this.prisma.event.findMany({
          where: { id: { in: [...byEventId.keys()] } },
          select: { id: true, name: true, slug: true, date: true },
        })
      : [];
    const byEvent = eventNames
      .map(e => ({
        eventId: e.id,
        name: e.name,
        slug: e.slug,
        date: e.date.toISOString(),
        impressions: byEventId.get(e.id)!.impressions,
        clicks: byEventId.get(e.id)!.clicks,
        ctrPct: this.pct(byEventId.get(e.id)!.clicks, byEventId.get(e.id)!.impressions),
      }))
      .sort((a, b) => b.impressions - a.impressions);

    return {
      sponsor,
      period: { from: start.toISOString(), to: end.toISOString() },
      totals: { impressions, clicks, uniqueReach, ctrPct: this.pct(clicks, impressions) },
      dailySeries: this.series(rows),
      byEvent,
    };
  }

  async eventSponsors(eventId: string, userId: string, userRole: UserRole) {
    await this.events.assertCanAccessEvent(eventId, userId, userRole);

    const [links, rows] = await Promise.all([
      this.prisma.eventSponsor.findMany({
        where: { eventId },
        select: {
          priority: true,
          status: true,
          sponsor: { select: { id: true, name: true, logoUrl: true, websiteUrl: true } },
        },
        orderBy: { priority: 'asc' },
      }),
      this.prisma.sponsorDailyRollup.findMany({
        where: { eventId },
        select: { sponsorId: true, day: true, impressions: true, clicks: true, uniqueReach: true },
        orderBy: { day: 'asc' },
      }),
    ]);

    const bySponsor = new Map<string, { impressions: number; clicks: number; uniqueReach: number }>();
    for (const r of rows) {
      const b = bySponsor.get(r.sponsorId) ?? { impressions: 0, clicks: 0, uniqueReach: 0 };
      b.impressions += r.impressions;
      b.clicks += r.clicks;
      b.uniqueReach += r.uniqueReach;
      bySponsor.set(r.sponsorId, b);
    }

    return {
      sponsors: links.map(l => {
        const b = bySponsor.get(l.sponsor.id) ?? { impressions: 0, clicks: 0, uniqueReach: 0 };
        return {
          sponsor: l.sponsor,
          status: l.status,
          priority: l.priority,
          impressions: b.impressions,
          clicks: b.clicks,
          uniqueReach: b.uniqueReach,
          ctrPct: this.pct(b.clicks, b.impressions),
        };
      }),
    };
  }

  private series(rows: Array<{ day: Date; impressions: number; clicks: number }>) {
    const byDay = new Map<string, { impressions: number; clicks: number }>();
    for (const r of rows) {
      const day = r.day.toISOString().slice(0, 10);
      const b = byDay.get(day) ?? { impressions: 0, clicks: 0 };
      b.impressions += r.impressions;
      b.clicks += r.clicks;
      byDay.set(day, b);
    }
    return [...byDay.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, v]) => ({ day, ...v }));
  }

  private range(from?: string, to?: string) {
    const end = to ? new Date(to) : new Date();
    const start = from ? new Date(from) : new Date(Date.now() - 90 * DAY);
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
    const c = new Date(d);
    c.setUTCHours(0, 0, 0, 0);
    return c;
  }

  private pct(n: number, d: number): number | null {
    if (!d || d <= 0) return null;
    return Number(((n / d) * 100).toFixed(1));
  }
}
