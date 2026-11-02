import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { DelayedError, Job } from 'bullmq';

import { PrismaService } from '../../../api/src/common/services/prisma.service';
import { MailService } from '../services/mail.service';
import { ChannelHealthService } from '../../../api/src/messaging/channel-health.service';
import { ChannelSendError, ClassifiedError } from '../../../api/src/messaging/delivery-errors';
import { cleanTemplateParam } from '../../../api/src/messaging/whatsapp-templates';
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
    private health: ChannelHealthService,
    private config: ConfigService,
  ) {
    super();
  }

  async process(job: Job<SendBibEmailJob>, token?: string): Promise<void> {
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
      await this.processDigest(job.data.subscriptionId, job, token);
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
   *
   * Los avisos salen por los canales del espacio (su Resend y su WhatsApp
   * Business). Lo que rechaza la cuenta del cliente (saldo, dominio, plantilla)
   * pausa ese canal y se le avisa; los avisos quedan pendientes, no se pierden.
   */
  private async processDigest(subscriptionId: string, job: Job<SendBibEmailJob>, token?: string): Promise<void> {
    const subscription = await this.prisma.bibSubscription.findUnique({
      where: { id: subscriptionId },
      include: {
        event: {
          select: {
            id: true, name: true, slug: true, isPublished: true, deletedAt: true, workspaceId: true,
            workspace: { select: { name: true, slug: true, customDomain: true, customDomainVerifiedAt: true } },
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
    const context = { eventId: event.id, subscriptionId: subscription.id };
    const retryable: Error[] = [];
    let delayMs = 0;
    let sentAny = false;

    const channels: Array<'EMAIL' | 'WHATSAPP'> = [];
    if (subscription.email && subscription.emailConsentAt) channels.push('EMAIL');
    if (subscription.phone && subscription.whatsappConsentAt) channels.push('WHATSAPP');

    for (const channel of channels) {
      const done = await this.prisma.bibNotificationLog.findMany({
        where: { subscriptionId: subscription.id, channel },
        select: { photoId: true },
      });
      const already = new Set(done.map(item => item.photoId));
      const fresh = eligible.filter(item => !already.has(item.photoId));
      if (!fresh.length) continue;

      const markNotified = () => this.prisma.bibNotificationLog.createMany({
        data: fresh.map(item => ({ subscriptionId: subscription.id, photoId: item.photoId, channel })),
        skipDuplicates: true,
      });

      try {
        if (channel === 'EMAIL') {
          const route = await this.health.emailRoute(event.workspaceId);
          if (route.kind === 'PAUSED') continue; // el cliente tiene que arreglar su canal; los avisos esperan
          const digest = {
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
          };
          if (route.kind === 'OWN') {
            const mail = this.mailService.buildRunnerDigest(digest);
            await route.client.send({ from: route.from, to: subscription.email!, subject: mail.subject, html: mail.html, headers: mail.headers, replyTo: route.replyTo });
          } else {
            await this.mailService.sendRunnerDigest({ ...digest, to: subscription.email!, fromDisplayName: event.workspace?.name });
          }
        } else {
          const route = await this.health.whatsappRoute(event.workspaceId, locale);
          if (route.kind !== 'OWN') continue; // sin canal propio activo no se envía WhatsApp
          await route.client.sendTemplate({
            phoneId: route.phoneId,
            to: subscription.phone!,
            name: route.template.name,
            language: route.template.language,
            params: [
              cleanTemplateParam(subscription.name, locale === 'en' ? 'runner' : 'corredor', 60),
              cleanTemplateParam(event.name, 'evento', 100),
              String(fresh.length),
              cleanTemplateParam(eventUrl, eventUrl, 500),
            ],
          });
        }
      } catch (error) {
        if (!(error instanceof ChannelSendError)) {
          retryable.push(error instanceof Error ? error : new Error(String(error)));
          continue;
        }
        const outcome = await this.handleFailure(event.workspaceId, event.workspace?.name, channel, error.detail, context);
        if (outcome === 'RECIPIENT') await markNotified(); // ese destinatario no se puede avisar: no se reintenta
        else if (outcome === 'LIMIT') delayMs = Math.max(delayMs, error.detail.retryAfterMs ?? 15 * 60_000);
        else if (outcome === 'RETRY') retryable.push(error);
        continue;
      }

      await markNotified();
      sentAny = true;
    }

    if (sentAny) {
      await this.prisma.bibSubscription.update({ where: { id: subscription.id }, data: { lastNotifiedAt: new Date() } });
    }
    if (retryable.length) throw retryable[0];
    if (delayMs && token) {
      // Un límite del proveedor se resuelve esperando: se aplaza el aviso sin gastar reintentos.
      const postponed = (job.data.limitRetries ?? 0) + 1;
      if (postponed <= 72) {
        await job.updateData({ ...job.data, limitRetries: postponed });
        await job.moveToDelayed(Date.now() + delayMs, token);
        throw new DelayedError();
      }
    }
  }

  /**
   * Qué hacer con un fallo clasificado. Devuelve cómo sigue ese aviso:
   * RECIPIENT (se descarta), LIMIT (se aplaza), RETRY (reintento normal) o
   * PAUSED (canal pausado, espera a que el cliente lo arregle).
   */
  private async handleFailure(
    workspaceId: string | null,
    workspaceName: string | undefined,
    channel: 'EMAIL' | 'WHATSAPP',
    detail: ClassifiedError,
    context: { eventId: string; subscriptionId: string },
  ): Promise<'RECIPIENT' | 'LIMIT' | 'RETRY' | 'PAUSED'> {
    this.logger.warn(`Aviso ${channel} no enviado (${detail.scope}/${detail.code}): ${detail.raw ?? detail.message}`);
    if (workspaceId) {
      const { alert } = await this.health.recordFailure(workspaceId, channel, detail, context).catch(error => {
        this.logger.warn(`No se pudo registrar el fallo: ${error?.message}`);
        return { alert: false };
      });
      if (alert) await this.alertOwner(workspaceId, workspaceName, channel, detail);
    }
    if (detail.scope === 'RECIPIENT') return 'RECIPIENT';
    if (detail.scope === 'LIMIT') return 'LIMIT';
    if (detail.scope === 'TRANSIENT') return 'RETRY';
    return 'PAUSED';
  }

  private async alertOwner(workspaceId: string, workspaceName: string | undefined, channel: 'EMAIL' | 'WHATSAPP', detail: ClassifiedError) {
    try {
      const who = await this.health.alertRecipient(workspaceId);
      if (!who) return;
      const frontend = this.config.get<string>('FRONTEND_URL', 'http://localhost:3000').replace(/\/$/, '');
      await this.mailService.sendChannelAlert({
        to: who.email,
        workspaceName: workspaceName ?? who.workspaceName,
        channel,
        message: detail.message,
        action: detail.action,
        helpUrl: detail.helpUrl,
        dashboardUrl: `${frontend}/dashboard/workspaces/${workspaceId}`,
      });
    } catch (error) {
      this.logger.warn(`No se pudo avisar al cliente del problema de su canal: ${error instanceof Error ? error.message : error}`);
    }
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
  async onFailed(job: Job<SendBibEmailJob> | undefined, err: Error) {
    this.logger.error(`Email job ${job?.id} falló: ${err.message}`);
    // Agotados los reintentos, queda constancia para que el cliente vea que hubo avisos sin salir.
    if (!job?.data.subscriptionId || job.attemptsMade < (job.opts.attempts ?? 1)) return;
    const subscription = await this.prisma.bibSubscription.findUnique({
      where: { id: job.data.subscriptionId },
      select: { id: true, eventId: true, event: { select: { workspaceId: true } } },
    }).catch(() => null);
    const workspaceId = subscription?.event.workspaceId;
    if (!subscription || !workspaceId) return;
    await this.health.recordFailure(
      workspaceId,
      'EMAIL',
      { scope: 'TRANSIENT', code: 'DELIVERY_FAILED', message: 'Un aviso no se pudo enviar tras varios intentos por un error del proveedor.', raw: err.message.slice(0, 200) },
      { eventId: subscription.eventId, subscriptionId: subscription.id },
    ).catch(() => undefined);
  }
}
