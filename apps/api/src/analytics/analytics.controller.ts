import { Controller, Get, Post, Param, Query, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Throttle } from '@nestjs/throttler';
import { ApiResponse } from '@shared/types';
import { AnalyticsService } from './analytics.service';
import { SponsorAnalyticsService } from './sponsor-analytics.service';
import { PostEventReportService } from './post-event-report.service';

@Controller()
@UseGuards(AuthGuard('jwt'))
export class AnalyticsController {
  constructor(
    private readonly analytics: AnalyticsService,
    private readonly sponsorAnalytics: SponsorAnalyticsService,
    private readonly report: PostEventReportService,
  ) {}

  // ── Evento ──────────────────────────────────────────────────────────────

  /** Analítica completa de un evento: pipeline, cobertura, embudo y comercio. */
  @Get('events/:eventId/analytics')
  @Throttle(60, 60)
  async eventAnalytics(@Param('eventId') eventId: string, @Req() req: any): Promise<ApiResponse> {
    return { data: await this.analytics.eventAnalytics(eventId, req.user.id, req.user.role) };
  }

  /** Fuerza el recálculo de la instantánea (para quien administra el evento). */
  @Post('events/:eventId/analytics/recompute')
  @Throttle(10, 60)
  async recompute(@Param('eventId') eventId: string, @Req() req: any): Promise<ApiResponse> {
    return { data: await this.analytics.recomputeEvent(eventId, req.user.id, req.user.role) };
  }

  /** Enlace de solo lectura del informe post-evento, para compartir. */
  @Get('events/:eventId/analytics/report-link')
  @Throttle(60, 60)
  async reportLink(@Param('eventId') eventId: string, @Req() req: any): Promise<ApiResponse> {
    await this.analytics.recomputeEvent(eventId, req.user.id, req.user.role);
    return { data: { url: await this.report.reportUrl(eventId) } };
  }

  /** Rota el enlace del informe: los ya compartidos dejan de funcionar. */
  @Post('events/:eventId/analytics/report-link/rotate')
  @Throttle(10, 60)
  async rotateReportLink(@Param('eventId') eventId: string, @Req() req: any): Promise<ApiResponse> {
    return { data: await this.report.rotateReportLink(eventId, req.user.id, req.user.role) };
  }

  /** Genera y envía el informe post-evento ahora (para demos / reenvíos). */
  @Post('events/:eventId/analytics/report')
  @Throttle(6, 60)
  async sendReport(@Param('eventId') eventId: string, @Req() req: any): Promise<ApiResponse> {
    return { data: await this.report.requestReport(eventId, req.user.id, req.user.role) };
  }

  @Get('events/:eventId/sponsors/analytics')
  @Throttle(60, 60)
  async eventSponsorAnalytics(@Param('eventId') eventId: string, @Req() req: any): Promise<ApiResponse> {
    return { data: await this.sponsorAnalytics.eventSponsors(eventId, req.user.id, req.user.role) };
  }

  // ── Espacio ─────────────────────────────────────────────────────────────

  /** Resumen del espacio, agregado desde los rollups diarios. */
  @Get('workspaces/:workspaceId/analytics/overview')
  @Throttle(60, 60)
  async workspaceOverview(
    @Param('workspaceId') workspaceId: string,
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @Req() req: any,
  ): Promise<ApiResponse> {
    return { data: await this.analytics.workspaceOverview(workspaceId, req.user.id, from, to) };
  }

  /** Tabla comparativa de eventos del espacio (requiere métricas avanzadas). */
  @Get('workspaces/:workspaceId/analytics/events')
  @Throttle(60, 60)
  async eventsComparison(
    @Param('workspaceId') workspaceId: string,
    @Req() req: any,
  ): Promise<ApiResponse> {
    return { data: await this.analytics.eventsComparison(workspaceId, req.user.id) };
  }

  @Get('workspaces/:workspaceId/sponsors/:sponsorId/analytics')
  @Throttle(60, 60)
  async sponsorAnalyticsOverview(
    @Param('workspaceId') workspaceId: string,
    @Param('sponsorId') sponsorId: string,
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @Req() req: any,
  ): Promise<ApiResponse> {
    return {
      data: await this.sponsorAnalytics.sponsorOverview(workspaceId, sponsorId, req.user.id, from, to),
    };
  }
}
