import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  forwardRef,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { createHmac, timingSafeEqual } from 'crypto';
import { PrismaService } from '../common/services/prisma.service';
import { MailerService } from '../common/services/mailer.service';
import { EventsService } from '../events/events.service';
import { PartnerWebhooksService } from '../partner-api/partner-webhooks.service';
import { UserRole } from '@shared/types';
import { AnalyticsRollupService } from './analytics-rollup.service';

const DAY = 86_400_000;

/**
 * Informe post-evento.
 *
 * A las 08:30 cada día busca eventos publicados cuya fecha fue hace ~2 días y
 * que todavía no tienen informe enviado, recalcula su instantánea, manda un
 * correo con el resumen al organizador y al espacio, marca el envío y emite el
 * webhook `analytics.report.ready`. El correo enlaza a una página pública de
 * solo lectura protegida por un token HMAC estable.
 */
@Injectable()
export class PostEventReportService {
  private readonly logger = new Logger(PostEventReportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly rollup: AnalyticsRollupService,
    private readonly mailer: MailerService,
    private readonly config: ConfigService,
    private readonly events: EventsService,
    // El otro extremo del ciclo con PartnerApiModule.
    @Inject(forwardRef(() => PartnerWebhooksService))
    private readonly webhooks: PartnerWebhooksService,
  ) {}

  // ── Token del enlace compartible ─────────────────────────────────────────
  //
  // Formato: `<versión>.<hmac40>`, donde el hmac firma también la versión. Subir
  // `reportTokenVersion` del evento invalida todos los enlaces anteriores sin
  // tocar el secreto global.

  private secret(): string {
    return (
      this.config.get<string>('METRICS_HASH_SECRET') ||
      this.config.get<string>('ORDER_ACCESS_SECRET') ||
      'lucilamon-local-metrics'
    );
  }

  private sign(eventId: string, version: number): string {
    return createHmac('sha256', this.secret())
      .update(`report|${eventId}|${version}`)
      .digest('hex')
      .slice(0, 40);
  }

  private async currentVersion(eventId: string): Promise<number> {
    const snap = await this.prisma.eventAnalyticsSnapshot.findUnique({
      where: { eventId },
      select: { reportTokenVersion: true },
    });
    return snap?.reportTokenVersion ?? 1;
  }

  async reportToken(eventId: string): Promise<string> {
    const version = await this.currentVersion(eventId);
    return `${version}.${this.sign(eventId, version)}`;
  }

  /** Valida integridad y devuelve la versión que trae el token, o null. */
  private parseToken(eventId: string, token: string): number | null {
    if (!token) return null;
    const dot = token.indexOf('.');
    if (dot <= 0) return null;
    const version = Number(token.slice(0, dot));
    const mac = token.slice(dot + 1);
    if (!Number.isInteger(version) || version < 1) return null;
    const expected = this.sign(eventId, version);
    if (mac.length !== expected.length) return null;
    try {
      return timingSafeEqual(Buffer.from(mac), Buffer.from(expected)) ? version : null;
    } catch {
      return null;
    }
  }

  /** true si el token es íntegro Y su versión es la vigente del evento. */
  async verifyToken(eventId: string, token: string): Promise<boolean> {
    const version = this.parseToken(eventId, token);
    if (version === null) return false;
    return version === (await this.currentVersion(eventId));
  }

  async reportUrl(eventId: string): Promise<string> {
    const base = (
      this.config.get<string>('PUBLIC_WEB_URL') ||
      this.config.get<string>('FRONTEND_URL') ||
      this.config.get<string>('APP_URL') ||
      'https://lucilamon.com'
    ).replace(/\/$/, '');
    return `${base}/reporte/${eventId}?token=${await this.reportToken(eventId)}`;
  }

  /** Rota el enlace: los que ya se compartieron dejan de funcionar. */
  async rotateReportLink(eventId: string, userId: string, userRole: UserRole) {
    await this.events.assertCanManageEvent(eventId, userId, userRole);
    await this.rollup.computeEventSnapshot(eventId);
    const updated = await this.prisma.eventAnalyticsSnapshot.update({
      where: { eventId },
      data: { reportTokenVersion: { increment: 1 } },
      select: { reportTokenVersion: true },
    });
    return { rotated: true, version: updated.reportTokenVersion, url: await this.reportUrl(eventId) };
  }

  // ── Cron ────────────────────────────────────────────────────────────────

  @Cron('30 8 * * *')
  async sendDueReports(): Promise<void> {
    try {
      const from = new Date(Date.now() - 3 * DAY);
      const to = new Date(Date.now() - 2 * DAY);
      const events = await this.prisma.event.findMany({
        where: {
          deletedAt: null,
          isPublished: true,
          date: { gte: from, lte: to },
          workspace: { is: { postEventReportsEnabled: true } },
          OR: [{ analyticsSnapshot: { is: null } }, { analyticsSnapshot: { reportSentAt: null } }],
        },
        select: { id: true, name: true },
        take: 200,
      });
      if (!events.length) return;
      this.logger.log(`Informe post-evento: ${events.length} evento(s) pendiente(s)`);
      for (const e of events) {
        await this.sendReport(e.id).catch(error =>
          this.logger.warn(`Informe de ${e.id} falló: ${error instanceof Error ? error.message : 'error'}`),
        );
      }
    } catch (error) {
      this.logger.error(`Cron de informes falló: ${error instanceof Error ? error.message : 'error'}`);
    }
  }

  // ── Envío ───────────────────────────────────────────────────────────────

  async requestReport(eventId: string, userId: string, userRole: UserRole) {
    await this.events.assertCanManageEvent(eventId, userId, userRole);
    return this.sendReport(eventId, { force: true });
  }

  async sendReport(eventId: string, opts: { force?: boolean } = {}) {
    const event = await this.prisma.event.findUnique({
      where: { id: eventId },
      include: {
        workspace: {
          select: { name: true, slug: true, contactEmail: true, owner: { select: { email: true } } },
        },
        owner: { select: { email: true } },
        contributors: {
          where: { role: 'EVENT_MANAGER', status: 'ACCEPTED' },
          select: { invitedEmail: true },
        },
      },
    });
    if (!event) throw new NotFoundException('Evento no encontrado');

    await this.rollup.computeEventSnapshot(eventId);
    const snapshot = await this.prisma.eventAnalyticsSnapshot.findUnique({ where: { eventId } });
    if (!snapshot) return { sent: 0, reason: 'sin datos' };

    if (!opts.force) {
      // Reserva atómica: solo la instancia que consigue marcarlo envía.
      const claimed = await this.prisma.eventAnalyticsSnapshot.updateMany({
        where: { eventId, reportSentAt: null },
        data: { reportSentAt: new Date() },
      });
      if (claimed.count !== 1) return { sent: 0, reason: 'ya enviado' };
    } else {
      await this.prisma.eventAnalyticsSnapshot.update({
        where: { eventId },
        data: { reportSentAt: new Date() },
      });
    }

    const recipients = [
      ...new Set(
        [
          event.workspace?.owner?.email,
          event.workspace?.contactEmail,
          event.owner?.email,
          ...event.contributors.map(c => c.invitedEmail),
        ]
          .filter((x): x is string => Boolean(x))
          .map(x => x.toLowerCase()),
      ),
    ];

    const url = await this.reportUrl(eventId);
    const html = this.renderEmail(event.name, event.workspace?.name ?? 'LucilaMon', snapshot, url);
    let sent = 0;
    for (const to of recipients) {
      const ok = await this.mailer
        .send({ to, subject: `Resumen del evento — ${event.name}`, html })
        .catch(() => false);
      if (ok) sent++;
    }

    if (event.workspaceId) {
      await this.webhooks
        .emit(event.workspaceId, 'analytics.report.ready' as any, {
          eventId,
          name: event.name,
          reportUrl: url,
          computedAt: snapshot.computedAt.toISOString(),
        })
        .catch(() => undefined);
    }

    this.logger.log(`Informe de "${event.name}" enviado a ${sent}/${recipients.length} destinatario(s)`);
    return { sent, recipients: recipients.length, reportUrl: url };
  }

  // ── Página pública de solo lectura ──────────────────────────────────────

  async publicReport(eventId: string, token: string) {
    if (!(await this.verifyToken(eventId, token))) {
      throw new ForbiddenException('Enlace de informe inválido');
    }
    const [event, snapshot] = await Promise.all([
      this.prisma.event.findFirst({
        where: { id: eventId, deletedAt: null },
        select: {
          name: true,
          slug: true,
          date: true,
          location: true,
          commerceMode: true,
          workspace: { select: { name: true, logoUrl: true, slug: true } },
        },
      }),
      this.prisma.eventAnalyticsSnapshot.findUnique({ where: { eventId } }),
    ]);
    if (!event || !snapshot) throw new NotFoundException('Informe no disponible');

    const s = snapshot;
    const searches = s.bibSearches + s.faceSearches;
    return {
      event: {
        name: event.name,
        slug: event.slug,
        date: event.date.toISOString(),
        location: event.location,
        commerceMode: event.commerceMode,
        workspace: event.workspace,
      },
      computedAt: s.computedAt.toISOString(),
      coverage: {
        fieldSize: s.fieldSize,
        athletesWithPhotos: s.distinctBibs,
        coveragePct: s.fieldSize ? this.pct(s.distinctBibs, s.fieldSize) : null,
        athletesWhoSearched: s.bibsSearched,
        claimRatePct: this.pct(s.bibsSearched, s.distinctBibs),
        athletesWhoBought: s.bibsWithSale,
      },
      engagement: {
        eventViews: s.eventViews,
        uniqueVisitors: s.uniqueVisitors,
        searches,
        noResultSearches: s.noResultSearches,
        discoveryRatePct: this.pct(Math.max(0, searches - s.noResultSearches), searches),
      },
      pipeline: {
        totalPhotos: s.totalPhotos,
        photosWithBib: s.photosWithBib,
        photosWithFace: s.photosWithFace,
        ocrHitRatePct: this.pct(s.photosWithBib, s.processedPhotos),
      },
      commerce: {
        grossCents: s.grossCents,
        purchases: s.purchases,
        freeDownloads: s.freeDownloads,
        organizerCommissionCents: s.organizerCommissionCents,
      },
      sponsors: {
        impressions: s.sponsorImpressions,
        clicks: s.sponsorClicks,
        ctrPct: this.pct(s.sponsorClicks, s.sponsorImpressions),
      },
      dailySeries: s.dailySeries ?? [],
      topCountries: s.topCountries ?? [],
    };
  }

  // ── Render ──────────────────────────────────────────────────────────────

  private renderEmail(eventName: string, workspaceName: string, s: any, reportUrl: string): string {
    // El nombre del evento y del espacio los escribe el cliente: se escapan
    // antes de meterlos en el HTML del correo.
    const esc = (value: string) =>
      String(value ?? '').replace(/[&<>"']/g, ch =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] as string),
      );
    const money = (c: number) => `$${((c ?? 0) / 100).toFixed(2)}`;
    const pct = (n: number, d: number) => (d > 0 ? `${((n / d) * 100).toFixed(0)}%` : '—');
    const url = esc(reportUrl);
    const safeEvent = esc(eventName);
    const safeWorkspace = esc(workspaceName);
    const row = (label: string, value: string) =>
      `<tr><td style="padding:8px 0;color:#555;font-size:14px">${label}</td>` +
      `<td style="padding:8px 0;text-align:right;font-weight:600;font-size:14px">${value}</td></tr>`;

    return `
<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111">
  <p style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#888;margin:0 0 4px">${safeWorkspace}</p>
  <h1 style="font-size:22px;margin:0 0 4px">Resumen del evento</h1>
  <p style="font-size:15px;color:#444;margin:0 0 20px">${safeEvent}</p>

  <table style="width:100%;border-collapse:collapse;border-top:1px solid #eee">
    ${row('Fotografías', String(s.totalPhotos))}
    ${row('Atletas con fotos', `${s.distinctBibs}${s.fieldSize ? ` (${pct(s.distinctBibs, s.fieldSize)} del field)` : ''}`)}
    ${row('Atletas que se buscaron', `${s.bibsSearched} (${pct(s.bibsSearched, s.distinctBibs)})`)}
    ${row('Visitas al evento', String(s.eventViews))}
    ${row('Visitantes únicos', String(s.uniqueVisitors))}
    ${row('Búsquedas', String(s.bibSearches + s.faceSearches))}
    ${row('Compras', String(s.purchases))}
    ${row('Descargas gratuitas', String(s.freeDownloads))}
    ${row('Ingresos brutos', money(s.grossCents))}
    ${s.sponsorImpressions ? row('Impresiones de patrocinador', String(s.sponsorImpressions)) : ''}
  </table>

  <a href="${url}" style="display:inline-block;margin-top:24px;background:#111;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-size:14px;font-weight:600">Ver informe completo</a>
  <p style="font-size:12px;color:#999;margin-top:16px">Enlace de solo lectura. Puedes reenviarlo a tu equipo o a tus patrocinadores.</p>
</div>`.trim();
  }

  private pct(n: number, d: number): number | null {
    if (!d || d <= 0) return null;
    return Number(((n / d) * 100).toFixed(1));
  }
}
