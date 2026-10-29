import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { PrismaService } from '../common/services/prisma.service';
import { MailerService } from '../common/services/mailer.service';
import { loadPhotoAllowance } from '../billing/metering.service';
import { PartnerWebhooksService } from './partner-webhooks.service';

/** Umbrales (en %) en los que se avisa. Cada uno se avisa una sola vez por periodo. */
export const ALERT_THRESHOLDS = [80, 100] as const;

export type UsageMetric = 'photos' | 'apiRequests' | 'faceSearches';

export interface UsageSnapshot {
  metric: UsageMetric;
  used: number;
  limit: number | null;
  /** Identifica el periodo (año contractual o mes) para no repetir el aviso. */
  periodKey: string;
}

/** Umbrales superados que todavía no se han avisado. Función pura: es lo que se prueba. */
export function crossedThresholds(used: number, limit: number | null, alreadySent: ReadonlySet<number>): number[] {
  if (!limit || limit <= 0) return [];
  const pct = (used / limit) * 100;
  return ALERT_THRESHOLDS.filter(t => pct >= t && !alreadySent.has(t));
}

/**
 * Avisos de consumo de los contratos Enterprise.
 *
 * Un cliente que descubre el tope cuando le rechazan una subida el día de la
 * carrera es un cliente perdido. Este cron compara el consumo con el contrato y,
 * al cruzar el 80 % y el 100 %, avisa por correo a sus contactos y emite el
 * webhook `usage.threshold`. El libro de uso guarda cada aviso con clave única,
 * así que no se repite aunque el cron corra varias veces.
 */
@Injectable()
export class UsageAlertsService {
  private readonly logger = new Logger(UsageAlertsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly webhooks: PartnerWebhooksService,
    @Optional() private readonly mailer?: MailerService,
  ) {}

  @Cron('*/30 * * * *')
  async run(): Promise<void> {
    const accounts = await this.prisma.enterpriseAccount.findMany({
      where: { status: { in: ['PILOT', 'ACTIVE'] } },
      select: { workspaceId: true },
    });
    let sent = 0;
    for (const { workspaceId } of accounts) {
      sent += await this.checkWorkspace(workspaceId).catch(error => {
        this.logger.warn(`Avisos de ${workspaceId}: ${error instanceof Error ? error.message : 'error'}`);
        return 0;
      });
    }
    if (sent) this.logger.log(`Avisos de consumo enviados: ${sent}`);
  }

  async snapshots(workspaceId: string, now = new Date()): Promise<UsageSnapshot[]> {
    const period = now.toISOString().slice(0, 7);
    const [account, usage, photos] = await Promise.all([
      this.prisma.enterpriseAccount.findUnique({ where: { workspaceId } }),
      this.prisma.partnerApiUsage.findUnique({ where: { workspaceId_period: { workspaceId, period } } }),
      loadPhotoAllowance(this.prisma, workspaceId, now),
    ]);
    if (!account) return [];
    return [
      { metric: 'photos', used: photos.used, limit: account.annualPhotoLimit, periodKey: photos.windowStart.toISOString().slice(0, 10) },
      { metric: 'apiRequests', used: Number(usage?.requestCount ?? 0n), limit: account.monthlyApiRequestLimit, periodKey: period },
      { metric: 'faceSearches', used: Number(usage?.faceSearchCount ?? 0n), limit: account.monthlyFaceSearchLimit, periodKey: period },
    ];
  }

  async checkWorkspace(workspaceId: string, now = new Date()): Promise<number> {
    let sent = 0;
    for (const snap of await this.snapshots(workspaceId, now)) {
      if (!snap.limit) continue;
      const keys = ALERT_THRESHOLDS.map(t => `alert:${snap.metric}:${t}:${workspaceId}:${snap.periodKey}`);
      const existing = await this.prisma.usageLedgerEntry.findMany({ where: { dedupeKey: { in: keys } }, select: { dedupeKey: true } });
      const done = new Set(existing.map(row => ALERT_THRESHOLDS.find(t => row.dedupeKey.startsWith(`alert:${snap.metric}:${t}:`))!));
      for (const threshold of crossedThresholds(snap.used, snap.limit, done)) {
        // La inserción con clave única es el cerrojo: solo quien la consigue avisa.
        const created = await this.prisma.usageLedgerEntry.createMany({
          data: [{ workspaceId, kind: 'ALERT', quantity: 0, dedupeKey: `alert:${snap.metric}:${threshold}:${workspaceId}:${snap.periodKey}` }],
          skipDuplicates: true,
        });
        if (created.count === 0) continue;
        await this.notify(workspaceId, snap, threshold);
        sent += 1;
      }
    }
    return sent;
  }

  private async notify(workspaceId: string, snap: UsageSnapshot, threshold: number): Promise<void> {
    const payload = { metric: snap.metric, threshold, used: snap.used, limit: snap.limit, period: snap.periodKey };
    await this.webhooks.emit(workspaceId, 'usage.threshold', payload).catch(error =>
      this.logger.warn(`Webhook usage.threshold de ${workspaceId}: ${error instanceof Error ? error.message : 'error'}`),
    );
    if (!this.mailer?.isConfigured) return;
    const account = await this.prisma.enterpriseAccount.findUnique({
      where: { workspaceId },
      select: { billingContactEmail: true, businessContactEmail: true, technicalContactEmail: true, workspace: { select: { name: true } } },
    });
    const to = [...new Set([account?.technicalContactEmail, account?.businessContactEmail, account?.billingContactEmail].filter(Boolean))] as string[];
    const label = { photos: 'fotografías del año', apiRequests: 'solicitudes API del mes', faceSearches: 'búsquedas faciales del mes' }[snap.metric];
    const subject = threshold >= 100 ? `Has alcanzado el límite de ${label}` : `Has usado el ${threshold} % de tus ${label}`;
    for (const address of to) {
      await this.mailer.send({
        to: address,
        subject: `${account?.workspace.name ?? 'LucilaMon'}: ${subject}`,
        html: `<div style="font-family:sans-serif;max-width:520px"><h2 style="margin:0 0 8px">${subject}</h2>
          <p>Has consumido <strong>${snap.used.toLocaleString('es')}</strong> de <strong>${snap.limit!.toLocaleString('es')}</strong> ${label}.</p>
          <p>${threshold >= 100
            ? 'A partir de ahora las operaciones que superen el límite pueden rechazarse o facturarse según tu contrato. Escríbenos para ampliarlo antes de tu próximo evento.'
            : 'Si tienes eventos próximos, conviene ampliar el cupo con tiempo. Puedes consultar tu consumo en cualquier momento en <code>GET /v1/partner/usage</code>.'}</p></div>`,
      }).catch(() => undefined);
    }
  }
}
