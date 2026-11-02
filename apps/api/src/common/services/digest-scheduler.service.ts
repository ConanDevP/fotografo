import { Injectable } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { QueueService } from './queue.service';

/** Una foto puede avisarse al corredor cuando está lista y aprobada. */
export const NOTIFIABLE_PHOTO = {
  status: 'PROCESSED' as const,
  publicationStatus: 'APPROVED' as const,
  watermarkUrl: { not: null },
};

/**
 * Decide a quién hay que avisar y lo encola. El envío en sí (y el filtro de qué
 * fotos faltan por avisar) ocurre en el worker, así que programar de más es
 * inofensivo: si no hay fotos nuevas, el trabajo termina sin enviar nada.
 */
@Injectable()
export class DigestSchedulerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
  ) {}

  /** Al publicar un evento: todos los registrados cuyo dorsal ya tiene fotos listas. */
  async scheduleForEvent(eventId: string, delayMs = 60_000): Promise<number> {
    const withPhotos = await this.prisma.photoBib.findMany({
      where: { eventId, photo: NOTIFIABLE_PHOTO },
      distinct: ['bib'],
      select: { bib: true },
    });
    return this.scheduleForBibs(eventId, withPhotos.map(item => item.bib), delayMs);
  }

  /** Tras arreglar un canal: reprograma los avisos de todos los eventos publicados del espacio. */
  async scheduleForWorkspace(workspaceId: string, delayMs = 5_000): Promise<number> {
    const events = await this.prisma.event.findMany({
      where: { workspaceId, deletedAt: null, isPublished: true, registrationEnabled: true },
      select: { id: true },
    });
    let total = 0;
    for (const event of events) total += await this.scheduleForEvent(event.id, delayMs);
    return total;
  }

  /** Al aprobar fotos: solo los dorsales que aparecen en ellas. */
  async scheduleForPhotos(eventId: string, photoIds: string[], delayMs?: number): Promise<number> {
    if (!photoIds.length) return 0;
    const bibs = await this.prisma.photoBib.findMany({
      where: { eventId, photoId: { in: photoIds } },
      distinct: ['bib'],
      select: { bib: true },
    });
    return this.scheduleForBibs(eventId, bibs.map(item => item.bib), delayMs);
  }

  async scheduleForBibs(eventId: string, bibs: string[], delayMs?: number): Promise<number> {
    if (!bibs.length) return 0;
    const subscriptions = await this.prisma.bibSubscription.findMany({
      where: { eventId, status: 'ACTIVE', bib: { in: bibs } },
      select: { id: true, bib: true },
    });
    for (const subscription of subscriptions) {
      await this.queue.addRegistrationDigestJob(subscription.id, eventId, subscription.bib, delayMs);
    }
    return subscriptions.length;
  }
}
