import { forwardRef, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { UserRole } from '@shared/types';
import { Request } from 'express';
import { PrismaService } from '../common/services/prisma.service';
import { MetricsService } from '../metrics/metrics.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { SponsorAnalyticsService } from '../analytics/sponsor-analytics.service';
import { PostEventReportService } from '../analytics/post-event-report.service';
import { PartnerPrincipal } from './partner-api.types';
import { PartnerMetricDto } from './dto/partner-commerce.dto';

/** Petición mínima con lo que lee el registro de métricas: IP, navegador, país y página de origen del visitante final. */
export function visitorRequest(visitor: PartnerMetricDto['visitor'], fallbackIp = 'partner'): Request {
  const headers: Record<string, string> = {};
  if (visitor?.userAgent) headers['user-agent'] = visitor.userAgent;
  if (visitor?.referrer) headers['referer'] = visitor.referrer;
  if (visitor?.country) headers['x-country-code'] = visitor.country;
  const ip = visitor?.ip || fallbackIp;
  return { ip, socket: { remoteAddress: ip }, headers, query: {} } as unknown as Request;
}

@Injectable()
export class PartnerInsightsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly metrics: MetricsService,
    @Inject(forwardRef(() => AnalyticsService)) private readonly analytics: AnalyticsService,
    @Inject(forwardRef(() => SponsorAnalyticsService)) private readonly sponsorAnalytics: SponsorAnalyticsService,
    @Inject(forwardRef(() => PostEventReportService)) private readonly reports: PostEventReportService,
  ) {}

  /** El actor de la credencial puede pertenecer a otros espacios: cada evento se comprueba contra el de la credencial. */
  private async assertEvent(principal: PartnerPrincipal, eventId: string) {
    const event = await this.prisma.event.findFirst({ where: { id: eventId, workspaceId: principal.workspaceId }, select: { id: true } });
    if (!event) throw new NotFoundException('Evento no encontrado');
  }

  /** Métricas de audiencia de la tienda propia del socio: alimentan el embudo y los informes. */
  async recordMetrics(principal: PartnerPrincipal, eventId: string, events: PartnerMetricDto[]) {
    await this.assertEvent(principal, eventId);
    let recorded = 0;
    for (const item of events) {
      await this.metrics.record(
        { type: item.type as any, eventId, photoId: item.photoId, sessionId: item.sessionId, source: item.source, metadata: item.metadata },
        visitorRequest(item.visitor),
        undefined,
        { trustedWorkspaceId: principal.workspaceId },
      );
      recorded += 1;
    }
    return { recorded };
  }

  async reportLink(principal: PartnerPrincipal, eventId: string) {
    await this.assertEvent(principal, eventId);
    await this.analytics.recomputeEvent(eventId, principal.actorUserId, principal.actorRole as UserRole);
    return { url: await this.reports.reportUrl(eventId) };
  }

  async rotateReportLink(principal: PartnerPrincipal, eventId: string) {
    await this.assertEvent(principal, eventId);
    return this.reports.rotateReportLink(eventId, principal.actorUserId, principal.actorRole as UserRole);
  }

  async sendReport(principal: PartnerPrincipal, eventId: string) {
    await this.assertEvent(principal, eventId);
    return this.reports.requestReport(eventId, principal.actorUserId, principal.actorRole as UserRole);
  }

  async eventSponsorAnalytics(principal: PartnerPrincipal, eventId: string) {
    await this.assertEvent(principal, eventId);
    return this.sponsorAnalytics.eventSponsors(eventId, principal.actorUserId, principal.actorRole as UserRole);
  }

  sponsorOverview(principal: PartnerPrincipal, sponsorId: string, from?: string, to?: string) {
    return this.sponsorAnalytics.sponsorOverview(principal.workspaceId, sponsorId, principal.actorUserId, from, to);
  }

  workspaceOverview(principal: PartnerPrincipal, from?: string, to?: string) {
    return this.analytics.workspaceOverview(principal.workspaceId, principal.actorUserId, from, to);
  }
}
