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
    
    this.logger.log(`Enviando email a ${email} para dorsal ${bib} en evento ${eventId}`);

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

      this.logger.log(`Email enviado exitosamente a ${email} con ${photos.length} fotos`);

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Error desconocido';
      const errorStack = error instanceof Error ? error.stack : undefined;
      this.logger.error(`Error enviando email para dorsal ${bib}: ${errorMessage}`, errorStack);
      throw error;
    }
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job<SendBibEmailJob>) {
    this.logger.log(`Email job ${job.id} completado para ${job.data.email}`);
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<SendBibEmailJob>, err: Error) {
    this.logger.error(`Email job ${job.id} falló para ${job.data.email}: ${err.message}`);
  }
}