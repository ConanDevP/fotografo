import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { PrismaService } from '../common/services/prisma.service';
import { MailerService } from '../common/services/mailer.service';
import { EventsService } from '../events/events.service';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Con cuántos días de antelación se avisa de que un evento va a borrarse. */
const NOTICE_DAYS = 14;

/** Fecha límite: lo anterior a ella ha superado la retención del contrato. Pura, para poder probarla. */
export function retentionCutoff(retentionDays: number, now: Date = new Date()): Date {
  return new Date(now.getTime() - retentionDays * DAY_MS);
}

/**
 * Retención de datos de los contratos Enterprise.
 *
 * El contrato fija cuántos días se conservan los eventos tras su fecha
 * (`retentionDays`). Pasado ese plazo se borran las fotografías, sus derivadas y
 * los vectores faciales: es lo que evita que el almacenamiento crezca sin límite
 * y lo que permite cumplir lo que prometes en la política de privacidad.
 *
 * Reglas de seguridad:
 *   · Nunca se borra un evento con compras (quien pagó conserva su descarga).
 *   · Se avisa a los contactos del contrato {@link NOTICE_DAYS} días antes.
 *   · Por defecto solo SIMULA y deja constancia en auditoría. El borrado real
 *     exige `RETENTION_ENFORCE=true`, para activarlo conscientemente.
 */
@Injectable()
export class DataRetentionService {
  private readonly logger = new Logger(DataRetentionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsService,
    @Optional() private readonly mailer?: MailerService,
  ) {}

  private get enforce(): boolean {
    return process.env.RETENTION_ENFORCE === 'true';
  }

  @Cron('30 4 * * *')
  async run(now: Date = new Date()): Promise<{ purged: number; simulated: number; notified: number; skippedWithSales: number }> {
    const totals = { purged: 0, simulated: 0, notified: 0, skippedWithSales: 0 };
    const accounts = await this.prisma.enterpriseAccount.findMany({
      where: { status: { in: ['PILOT', 'ACTIVE'] }, retentionDays: { not: null } },
      select: { workspaceId: true, retentionDays: true, technicalContactEmail: true, businessContactEmail: true, workspace: { select: { name: true } } },
    });

    for (const account of accounts) {
      try {
        const cutoff = retentionCutoff(account.retentionDays!, now);
        const due = await this.prisma.event.findMany({
          where: { workspaceId: account.workspaceId, date: { lt: cutoff } },
          select: { id: true, name: true },
          take: 200,
        });

        const purgeable: Array<{ id: string; name: string }> = [];
        for (const event of due) {
          const sales = await this.prisma.order.count({
            where: { eventId: event.id, status: { in: ['PAID', 'REFUNDED', 'DISPUTED'] } },
          });
          if (sales > 0) totals.skippedWithSales += 1;
          else purgeable.push(event);
        }

        if (purgeable.length) {
          if (this.enforce) {
            for (const event of purgeable) {
              await this.events.purgeForRetention(event.id);
              totals.purged += 1;
            }
            await this.audit('RETENTION_PURGED', account.workspaceId, purgeable);
          } else {
            totals.simulated += purgeable.length;
            await this.audit('RETENTION_DRY_RUN', account.workspaceId, purgeable);
            this.logger.warn(
              `[SIMULACIÓN] ${account.workspace.name}: ${purgeable.length} evento(s) superan ${account.retentionDays} días. ` +
                'Define RETENTION_ENFORCE=true para borrarlos.',
            );
          }
        }

        totals.notified += await this.notifyUpcoming(account, cutoff, account.retentionDays!);
      } catch (error) {
        this.logger.error(`Retención de ${account.workspaceId}: ${error instanceof Error ? error.message : 'error'}`);
      }
    }
    return totals;
  }

  /** Avisa de los eventos que se borrarán en los próximos días, una sola vez por evento. */
  private async notifyUpcoming(
    account: { workspaceId: string; technicalContactEmail: string | null; businessContactEmail: string | null; workspace: { name: string } },
    cutoff: Date,
    retentionDays: number,
  ): Promise<number> {
    if (!this.mailer?.isConfigured) return 0;
    const to = [...new Set([account.technicalContactEmail, account.businessContactEmail].filter(Boolean))] as string[];
    if (!to.length) return 0;
    const soon = await this.prisma.event.findMany({
      where: { workspaceId: account.workspaceId, date: { gte: cutoff, lt: new Date(cutoff.getTime() + NOTICE_DAYS * DAY_MS) } },
      select: { id: true, name: true, date: true },
      take: 100,
    });
    let notified = 0;
    for (const event of soon) {
      const created = await this.prisma.usageLedgerEntry.createMany({
        data: [{ workspaceId: account.workspaceId, kind: 'ALERT', quantity: 0, dedupeKey: `retention-notice:${event.id}`, eventId: event.id }],
        skipDuplicates: true,
      });
      if (created.count === 0) continue;
      const deletionDate = new Date(event.date.getTime() + retentionDays * DAY_MS).toISOString().slice(0, 10);
      for (const address of to) {
        await this.mailer.send({
          to: address,
          subject: `${account.workspace.name}: "${event.name}" se eliminará en los próximos días`,
          html: `<div style="font-family:sans-serif;max-width:520px"><h2 style="margin:0 0 8px">Retención de datos</h2>
            <p>Según tu contrato, las fotografías del evento <strong>${event.name}</strong> se eliminarán el <strong>${deletionDate}</strong>.</p>
            <p>Descarga lo que necesites ahora mediante la API o desde tu panel. Si quieres ampliar la retención, escríbenos.</p></div>`,
        }).catch(() => undefined);
      }
      notified += 1;
    }
    return notified;
  }

  private async audit(action: string, workspaceId: string, events: Array<{ id: string; name: string }>) {
    await this.prisma.auditLog
      .create({ data: { action, data: { workspaceId, events: events.slice(0, 50), total: events.length } } })
      .catch(() => undefined);
  }
}
