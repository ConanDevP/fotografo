import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';

import { PrismaService } from '../../../api/src/common/services/prisma.service';
import { MailService } from '../services/mail.service';
import { WhatsAppDeliveryError, WhatsAppService } from '../services/whatsapp.service';
import { ConfigService } from '@nestjs/config';
import { signUnsubscribeToken } from '@shared/registration';
import { SendBibEmailJob } from '@shared/types';
import { QUEUES } from '@shared/constants';

@Processor(QUEUES.SEND_BIB_EMAIL)
export class SendBibEmailProcessor extends WorkerHost {
  private readonly logger = new Logger(SendBibEmailProcessor.name);

  constructor(
    private prisma: PrismaService,
    private mailService: MailService,
    private whatsApp: WhatsAppService,
    private config: ConfigService,
  ) {
    super();
  }

  async process(job: Job<SendBibEmailJob>): Promise<void> {
    const { eventId, bib, email, photoIds } = job.data;

    if (job.data.kind === 'EVENT_INVITATION') {
      if (!job.data.eventName || !job.data.workspaceName || !job.data.acceptanceUrl) {
        throw new Error('Invitación incompleta');
      }
      await this.mailService.sendEventInvitation({
        email,
        eventName: job.data.eventName,
        workspaceName: job.data.workspaceName,
        acceptanceUrl: job.data.acceptanceUrl,
        organizerCommissionPercent: job.data.organizerCommissionPercent || 0,
        rightsTerms: job.data.rightsTerms,
      });
      return;
    }

    if (job.data.kind === 'ORDER_CONFIRMATION') {
      if (!job.data.orderId || !job.data.downloadToken) {
        throw new Error('Confirmación de pedido incompleta');
      }
      const event = await this.prisma.event.findUnique({
        where: { id: eventId },
        select: { name: true },
      });
      if (!event) throw new Error(`Evento ${eventId} no encontrado`);
      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
      const downloadUrl = job.data.storefrontUrl
        ? new URL(`/pago?orderId=${encodeURIComponent(job.data.orderId)}`, job.data.storefrontUrl)
        : new URL(`/download/${job.data.orderId}`, frontendUrl);
      downloadUrl.hash = new URLSearchParams({ token: job.data.downloadToken }).toString();
      await this.mailService.sendOrderConfirmation(
        email,
        job.data.orderId,
        event.name,
        downloadUrl.toString(),
      );
      return;
    }
    
    if (job.data.subscriptionId) {
      await this.processDigest(job.data.subscriptionId);
      return;
    }

    this.logger.log(`Procesando notificación del dorsal ${bib} en evento ${eventId}`);

    try {
      // Get event data
      const event = await this.prisma.event.findUnique({
        where: { id: eventId },
        select: { name: true },
      });

      if (!event) {
        throw new Error(`Evento ${eventId} no encontrado`);
      }

      // Get photos for this bib (either specific photoIds or search by bib)
      let photos;
      
      if (photoIds && photoIds.length > 0) {
        // Use specific photo IDs
        photos = await this.prisma.photo.findMany({
          where: {
            id: { in: photoIds },
            eventId,
            status: 'PROCESSED',
            publicationStatus: 'APPROVED',
            thumbUrl: { not: null },
            watermarkUrl: { not: null },
          },
          select: {
            id: true,
            thumbUrl: true,
            watermarkUrl: true,
            watermarkThumbUrl: true,
          },
        });
      } else {
        // Find photos by bib
        photos = await this.prisma.photo.findMany({
          where: {
            eventId,
            bibs: {
              some: { bib },
            },
            status: 'PROCESSED',
            publicationStatus: 'APPROVED',
            thumbUrl: { not: null },
            watermarkUrl: { not: null },
          },
          select: {
            id: true,
            thumbUrl: true,
            watermarkUrl: true,
            watermarkThumbUrl: true,
          },
          orderBy: {
            createdAt: 'desc',
          },
          take: 20, // Limit to 20 photos per email
        });
      }

      if (photos.length === 0) {
        this.logger.warn(`No se encontraron fotos procesadas para dorsal ${bib} en evento ${eventId}`);
        return;
      }

      // Send email notification
      await this.mailService.sendBibNotification(
        email,
        bib,
        event.name,
        photos.map(photo => ({
          photoId: photo.id,
          // La miniatura limpia no puede salir en un correo: se usa la de marca de agua.
          thumbUrl: photo.watermarkThumbUrl ?? photo.watermarkUrl!,
          watermarkUrl: photo.watermarkUrl!,
        })),
      );

      this.logger.log(`Notificación enviada con ${photos.length} fotos`);

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Error desconocido';
      const errorStack = error instanceof Error ? error.stack : undefined;
      this.logger.error(`Error enviando email para dorsal ${bib}: ${errorMessage}`, errorStack);
      throw error;
    }
  }

  /**
   * Aviso agrupado de una suscripción: reúne las fotos aprobadas de su dorsal
   * que ese canal aún no ha avisado y manda un solo mensaje. Cada canal lleva
   * su propia cuenta, así que si WhatsApp falla y el correo no, el reintento
   * solo repite WhatsApp.
   */
  private async processDigest(subscriptionId: string): Promise<void> {
    const subscription = await this.prisma.bibSubscription.findUnique({
      where: { id: subscriptionId },
      include: {
        event: {
          select: {
            id: true, name: true, slug: true, isPublished: true, deletedAt: true,
            workspace: { select: { slug: true, customDomain: true, customDomainVerifiedAt: true } },
          },
        },
      },
    });
    if (!subscription || subscription.status !== 'ACTIVE') return;
    const { event } = subscription;
    if (event.deletedAt || !event.isPublished) return;

    const eligible = await this.prisma.photoBib.findMany({
      where: {
        eventId: event.id,
        bib: subscription.bib,
        photo: { status: 'PROCESSED', publicationStatus: 'APPROVED', watermarkUrl: { not: null } },
      },
      distinct: ['photoId'],
      orderBy: { id: 'desc' },
      take: 200,
      select: { photoId: true, photo: { select: { watermarkThumbUrl: true, watermarkUrl: true } } },
    });
    if (!eligible.length) return;

    const locale: 'es' | 'en' = subscription.locale === 'en' ? 'en' : 'es';
    const eventUrl = this.eventUrl(event, subscription.bib);
    const unsubscribeUrl = this.unsubscribeUrl(subscription.id);
    const failures: Error[] = [];
    let sentAny = false;

    const channels: Array<'EMAIL' | 'WHATSAPP'> = [];
    if (subscription.email && subscription.emailConsentAt) channels.push('EMAIL');
    if (subscription.phone && subscription.whatsappConsentAt && this.whatsApp.enabled()) channels.push('WHATSAPP');

    for (const channel of channels) {
      const done = await this.prisma.bibNotificationLog.findMany({
        where: { subscriptionId: subscription.id, channel },
        select: { photoId: true },
      });
      const already = new Set(done.map(item => item.photoId));
      const fresh = eligible.filter(item => !already.has(item.photoId));
      if (!fresh.length) continue;

      try {
        if (channel === 'EMAIL') {
          await this.mailService.sendRunnerDigest({
            to: subscription.email!,
            locale,
            name: subscription.name,
            bib: subscription.bib,
            eventName: event.name,
            previews: fresh
              .map(item => item.photo.watermarkThumbUrl ?? item.photo.watermarkUrl)
              .filter((url): url is string => !!url)
              .slice(0, 6),
            totalPhotos: fresh.length,
            eventUrl,
            unsubscribeUrl,
            unsubscribePostUrl: this.unsubscribePostUrl(subscription.id),
          });
        } else {
          await this.whatsApp.sendPhotosReady({
            to: subscription.phone!,
            locale,
            name: subscription.name,
            eventName: event.name,
            photoCount: fresh.length,
            url: eventUrl,
          });
        }
      } catch (error) {
        // Un fallo permanente (número sin WhatsApp, plantilla mal) se da por
        // avisado para no reintentar eternamente; uno pasajero se reintenta.
        if (!(error instanceof WhatsAppDeliveryError && error.permanent)) {
          failures.push(error instanceof Error ? error : new Error(String(error)));
          continue;
        }
        this.logger.warn(`WhatsApp no entregable para la suscripción ${subscription.id}: ${error.message}`);
      }

      await this.prisma.bibNotificationLog.createMany({
        data: fresh.map(item => ({ subscriptionId: subscription.id, photoId: item.photoId, channel })),
        skipDuplicates: true,
      });
      sentAny = true;
    }

    if (sentAny) {
      await this.prisma.bibSubscription.update({
        where: { id: subscription.id },
        data: { lastNotifiedAt: new Date() },
      });
    }
    if (failures.length) throw failures[0];
  }

  private eventUrl(
    event: { slug: string; workspace: { slug: string; customDomain: string | null; customDomainVerifiedAt: Date | null } | null },
    bib: string,
  ): string {
    const frontend = this.config.get<string>('FRONTEND_URL', 'http://localhost:3000').replace(/\/$/, '');
    const query = `?bib=${encodeURIComponent(bib)}`;
    const workspace = event.workspace;
    if (workspace?.customDomain && workspace.customDomainVerifiedAt) {
      return `https://${workspace.customDomain}/eventos/${event.slug}${query}`;
    }
    if (workspace) return `${frontend}/s/${workspace.slug}/eventos/${event.slug}${query}`;
    return `${frontend}/search/events/${event.slug}${query}`;
  }

  private registrationSecret(): string {
    const secret = this.config.get<string>('REGISTRATION_SECRET');
    if (secret) return secret;
    if (this.config.get('NODE_ENV') === 'production') throw new Error('REGISTRATION_SECRET no está configurado');
    return 'dev-registration-secret';
  }

  private unsubscribeUrl(subscriptionId: string): string {
    const frontend = this.config.get<string>('FRONTEND_URL', 'http://localhost:3000').replace(/\/$/, '');
    return `${frontend}/r/baja?t=${encodeURIComponent(signUnsubscribeToken(subscriptionId, this.registrationSecret()))}`;
  }

  /** Destino del "darse de baja" de un clic del cliente de correo; necesita la URL pública de la API. */
  private unsubscribePostUrl(subscriptionId: string): string | undefined {
    const api = (this.config.get<string>('API_PUBLIC_URL') || this.config.get<string>('API_URL') || '').replace(/\/$/, '');
    if (!api.startsWith('https://')) return undefined;
    return `${api}/v1/public/registrations/unsubscribe?t=${encodeURIComponent(signUnsubscribeToken(subscriptionId, this.registrationSecret()))}`;
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job<SendBibEmailJob>) {
    this.logger.log(`Email job ${job.id} completado`);
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<SendBibEmailJob>, err: Error) {
    this.logger.error(`Email job ${job.id} falló: ${err.message}`);
  }
}
