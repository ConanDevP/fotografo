import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';

import { PrismaService } from '../../../api/src/common/services/prisma.service';
import { MailService } from '../services/mail.service';
import { SendBibEmailJob } from '@shared/types';
import { QUEUES } from '@shared/constants';

@Processor(QUEUES.SEND_BIB_EMAIL)
export class SendBibEmailProcessor extends WorkerHost {
  private readonly logger = new Logger(SendBibEmailProcessor.name);

  constructor(
    private prisma: PrismaService,
    private mailService: MailService,
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
      const downloadUrl = new URL(`/download/${job.data.orderId}`, frontendUrl);
      downloadUrl.hash = new URLSearchParams({ token: job.data.downloadToken }).toString();
      await this.mailService.sendOrderConfirmation(
        email,
        job.data.orderId,
        event.name,
        downloadUrl.toString(),
      );
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
          thumbUrl: photo.thumbUrl!,
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

  @OnWorkerEvent('completed')
  onCompleted(job: Job<SendBibEmailJob>) {
    this.logger.log(`Email job ${job.id} completado`);
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<SendBibEmailJob>, err: Error) {
    this.logger.error(`Email job ${job.id} falló: ${err.message}`);
  }
}
