import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/services/prisma.service';

/**
 * Prioridades de la cola de procesamiento (BullMQ: el número menor va primero).
 *
 * Importante: en BullMQ un trabajo SIN prioridad se atiende antes que cualquiera
 * con prioridad. Por eso los trabajos normales llevan una prioridad explícita
 * (10) en lugar de ninguna: si no, un trabajo sin marcar pasaría por delante de
 * los de los clientes con procesamiento prioritario.
 */
export const PROCESSING_PRIORITY = { PRIORITY: 1, NORMAL: 10 } as const;

const CACHE_MS = 60_000;

@Injectable()
export class ProcessingPriorityService {
  private readonly cache = new Map<string, { value: number; expires: number }>();

  constructor(private readonly prisma: PrismaService) {}

  /** Prioridad con la que se encola una fotografía de este espacio. */
  async forWorkspace(workspaceId: string | null | undefined, now = Date.now()): Promise<number> {
    if (!workspaceId) return PROCESSING_PRIORITY.NORMAL;
    const hit = this.cache.get(workspaceId);
    if (hit && hit.expires > now) return hit.value;

    const account = await this.prisma.enterpriseAccount.findUnique({
      where: { workspaceId },
      select: { status: true, contractStart: true, contractEnd: true, priorityProcessingEnabled: true },
    });
    const at = new Date(now);
    const entitled = !!account
      && account.priorityProcessingEnabled
      && ['PILOT', 'ACTIVE'].includes(account.status)
      && (!account.contractStart || account.contractStart <= at)
      && (!account.contractEnd || account.contractEnd > at);
    const value = entitled ? PROCESSING_PRIORITY.PRIORITY : PROCESSING_PRIORITY.NORMAL;
    this.cache.set(workspaceId, { value, expires: now + CACHE_MS });
    return value;
  }
}
