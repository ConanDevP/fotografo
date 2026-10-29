import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/services/prisma.service';
import { creditWindow, PHOTO_CREDIT_KIND } from './usage-window';

export interface PhotoAllowance {
  /** `true` si el tope anual bloquea las subidas (contrato activo, con tope y sin exceso permitido). */
  enforced: boolean;
  /** `true` si el contrato permite pasarse del cupo y factura el exceso. */
  overage: boolean;
  limit: number | null;
  used: number;
  remaining: number | null;
  windowStart: Date;
  windowEnd: Date;
}

/** Cupo de fotografías de un espacio: lo comparten el medidor, el panel y la API de socios. */
export async function loadPhotoAllowance(prisma: PrismaService, workspaceId: string, now: Date = new Date()): Promise<PhotoAllowance> {
  const account = await prisma.enterpriseAccount.findUnique({
    where: { workspaceId },
    select: { status: true, contractStart: true, contractEnd: true, annualPhotoLimit: true, allowOverage: true },
  });
  const active = !!account
    && ['PILOT', 'ACTIVE'].includes(account.status)
    && (!account.contractStart || account.contractStart <= now)
    && (!account.contractEnd || account.contractEnd > now);
  const window = creditWindow(active ? account!.contractStart : null, now);
  const sum = await prisma.usageLedgerEntry.aggregate({
    where: { workspaceId, kind: PHOTO_CREDIT_KIND, createdAt: { gte: window.start, lt: window.end > now ? window.end : new Date(now.getTime() + 1) } },
    _sum: { quantity: true },
  });
  const used = Number(sum._sum.quantity ?? 0);
  const limit = active ? account!.annualPhotoLimit ?? null : null;
  const overage = limit != null && !!account!.allowOverage;
  return {
    enforced: limit != null && !overage,
    overage,
    limit,
    used,
    remaining: limit == null ? null : Math.max(0, limit - used),
    windowStart: window.start,
    windowEnd: window.end,
  };
}

/**
 * Libro de créditos por espacio.
 *
 * Una fotografía consume un crédito cuando su subida queda verificada. El
 * consumo se anota siempre (también en planes self-serve, porque es la base de
 * la facturación por uso); el tope solo se hace cumplir cuando el espacio tiene
 * un contrato Enterprise activo con `annualPhotoLimit`.
 */
@Injectable()
export class MeteringService {
  private readonly logger = new Logger(MeteringService.name);

  constructor(private readonly prisma: PrismaService) {}

  photoAllowance(workspaceId: string, now: Date = new Date()): Promise<PhotoAllowance> {
    return loadPhotoAllowance(this.prisma, workspaceId, now);
  }

  /**
   * Espacio al que se imputa una fotografía: el del organizador si su evento
   * está bajo un contrato Enterprise vigente (cupo, exceso, factura y prioridad
   * son del contrato, suba quien suba), y el del propio fotógrafo en los demás casos.
   */
  async meteredWorkspace(eventId: string, photographerWorkspaceId: string | null | undefined, now: Date = new Date()): Promise<string | null | undefined> {
    const event = await this.prisma.event.findUnique({ where: { id: eventId }, select: { workspaceId: true } });
    if (!event?.workspaceId || event.workspaceId === photographerWorkspaceId) return photographerWorkspaceId;
    const account = await this.prisma.enterpriseAccount.findUnique({
      where: { workspaceId: event.workspaceId },
      select: { status: true, contractStart: true, contractEnd: true },
    });
    const active = !!account
      && ['PILOT', 'ACTIVE'].includes(account.status)
      && (!account.contractStart || account.contractStart <= now)
      && (!account.contractEnd || account.contractEnd > now);
    return active ? event.workspaceId : photographerWorkspaceId;
  }

  /**
   * Corta la creación de un evento que superaría el tope anual del contrato.
   * Cuenta los eventos creados en el año contractual (también los borrados:
   * borrar no devuelve el cupo) para que el tope no se pueda esquivar.
   */
  async assertEventCapacity(workspaceId: string | null | undefined, now: Date = new Date()): Promise<void> {
    if (!workspaceId) return;
    const account = await this.prisma.enterpriseAccount.findUnique({
      where: { workspaceId },
      select: { status: true, contractStart: true, contractEnd: true, annualEventLimit: true },
    });
    if (!account || account.annualEventLimit == null) return;
    const active = ['PILOT', 'ACTIVE'].includes(account.status)
      && (!account.contractStart || account.contractStart <= now)
      && (!account.contractEnd || account.contractEnd > now);
    if (!active) return;
    const window = creditWindow(account.contractStart, now);
    const used = await this.prisma.event.count({ where: { workspaceId, createdAt: { gte: window.start, lt: window.end > now ? window.end : new Date(now.getTime() + 1) } } });
    if (used >= account.annualEventLimit) {
      throw new ForbiddenException({
        code: 'EVENT_LIMIT_REACHED',
        message:
          `Tu contrato incluye ${account.annualEventLimit.toLocaleString('es')} eventos al año y ya has creado ` +
          `${used.toLocaleString('es')}. Contacta con tu gestor para ampliar el cupo.`,
        limit: account.annualEventLimit,
        used,
        resetsAt: window.end.toISOString(),
      });
    }
  }

  /**
   * Corta una subida que superaría el cupo anual. Se llama antes de firmar las
   * URLs de carga: rechazar aquí no cuesta nada, rechazar después sí.
   */
  async assertPhotoCapacity(workspaceId: string | null | undefined, incoming: number): Promise<void> {
    if (!workspaceId || incoming <= 0) return;
    const allowance = await this.photoAllowance(workspaceId);
    if (!allowance.enforced || allowance.limit == null) return;
    if (allowance.used + incoming > allowance.limit) {
      throw new ForbiddenException({
        code: 'PHOTO_LIMIT_REACHED',
        message:
          `Tu contrato incluye ${allowance.limit.toLocaleString('es')} fotografías al año y ya has usado ` +
          `${allowance.used.toLocaleString('es')}. Contacta con tu gestor para ampliar el cupo.`,
        limit: allowance.limit,
        used: allowance.used,
        requested: incoming,
        resetsAt: allowance.windowEnd.toISOString(),
      });
    }
  }

  /** Anota el consumo de una fotografía. Idempotente: reintentos y reprocesos no duplican. */
  async recordPhoto(workspaceId: string | null | undefined, photoId: string, eventId?: string | null): Promise<void> {
    if (!workspaceId) return;
    try {
      await this.prisma.usageLedgerEntry.createMany({
        data: [{ workspaceId, kind: PHOTO_CREDIT_KIND, quantity: 1, dedupeKey: `photo:${photoId}`, photoId, eventId: eventId ?? null }],
        skipDuplicates: true,
      });
    } catch (error) {
      // Un fallo del medidor nunca debe tumbar una subida ya verificada.
      this.logger.error(`No se pudo anotar el crédito de ${photoId}: ${error instanceof Error ? error.message : 'error'}`);
    }
  }
}
