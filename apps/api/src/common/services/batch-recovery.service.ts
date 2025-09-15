import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from './prisma.service';
import { QueueService } from './queue.service';

@Injectable()
export class BatchRecoveryService {
  private readonly logger = new Logger(BatchRecoveryService.name);

  constructor(
    private prisma: PrismaService,
    private queueService: QueueService,
  ) {}

  // Ejecutar cada 5 minutos para batch jobs stuck
  @Cron('*/5 * * * *')
  async recoverStuckBatches() {
    try {
      this.logger.log('Iniciando recuperación de batch jobs stuck');

      // Buscar batch jobs en PROCESSING por más de 30 minutos
      const stuckBatches = await this.prisma.batchUploadJob.findMany({
        where: {
          status: 'PROCESSING',
          updatedAt: {
            lt: new Date(Date.now() - 30 * 60 * 1000), // 30 minutos sin actualización
          },
        },
        include: {
          photos: {
            where: { status: 'PENDING' },
            select: { id: true, eventId: true, cloudinaryId: true }
          }
        },
        take: 10, // Máximo 10 batch jobs por vez
      });

      for (const batch of stuckBatches) {
        this.logger.warn(`Batch job stuck detectado: ${batch.id} (${batch.photos.length} fotos pendientes)`);
        
        // Re-encolar fotos pendientes
        for (const photo of batch.photos) {
          if (photo.cloudinaryId && photo.cloudinaryId !== 'temp') {
            try {
              await this.queueService.addProcessPhotoJob({
                photoId: photo.id,
                eventId: photo.eventId,
                objectKey: photo.cloudinaryId,
              }, 5); // Prioridad alta para recovery
              
              this.logger.log(`Foto re-encolada: ${photo.id}`);
            } catch (error) {
              this.logger.error(`Error re-encolando foto ${photo.id}: ${error instanceof Error ? error.message : 'Unknown error'}`);
            }
          }
        }

        // Actualizar timestamp del batch para evitar re-procesamiento inmediato
        await this.prisma.batchUploadJob.update({
          where: { id: batch.id },
          data: { updatedAt: new Date() }
        });
      }

      if (stuckBatches.length > 0) {
        this.logger.log(`Recovery completado: ${stuckBatches.length} batch jobs recuperados`);
      }

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const errorStack = error instanceof Error ? error.stack : undefined;
      this.logger.error(`Error en batch recovery: ${errorMessage}`, errorStack);
    }
  }

  // Recovery manual para batch específico
  async recoverBatch(batchId: string): Promise<{ recovered: number; skipped: number }> {
    this.logger.log(`Iniciando recovery manual para batch ${batchId}`);
    
    const batch = await this.prisma.batchUploadJob.findUnique({
      where: { id: batchId },
      include: {
        photos: {
          where: { 
            OR: [
              { status: 'PENDING' },
              { status: 'FAILED' }
            ]
          },
          select: { id: true, eventId: true, cloudinaryId: true, status: true }
        }
      }
    });

    if (!batch) {
      throw new Error(`Batch job ${batchId} no encontrado`);
    }

    let recovered = 0;
    let skipped = 0;

    for (const photo of batch.photos) {
      if (photo.cloudinaryId && photo.cloudinaryId !== 'temp') {
        try {
          await this.queueService.addProcessPhotoJob({
            photoId: photo.id,
            eventId: photo.eventId,
            objectKey: photo.cloudinaryId,
          }, 10); // Máxima prioridad

          // Marcar como PENDING para reprocesamiento
          await this.prisma.photo.update({
            where: { id: photo.id },
            data: { status: 'PENDING' }
          });

          recovered++;
          this.logger.log(`Foto ${photo.id} marcada para recovery`);
        } catch (error) {
          this.logger.error(`Error en recovery foto ${photo.id}: ${error instanceof Error ? error.message : 'Unknown error'}`);
          skipped++;
        }
      } else {
        skipped++;
        this.logger.warn(`Foto ${photo.id} skipped - cloudinaryId inválido: ${photo.cloudinaryId}`);
      }
    }

    // Actualizar status del batch
    await this.prisma.batchUploadJob.update({
      where: { id: batchId },
      data: { 
        status: recovered > 0 ? 'PROCESSING' : 'FAILED',
        updatedAt: new Date() 
      }
    });

    this.logger.log(`Batch ${batchId} recovery: ${recovered} recovered, ${skipped} skipped`);
    return { recovered, skipped };
  }

  // Estadísticas de recovery
  async getRecoveryStats() {
    const [stuckBatches, failedPhotos, pendingPhotos] = await Promise.all([
      this.prisma.batchUploadJob.count({
        where: {
          status: 'PROCESSING',
          updatedAt: {
            lt: new Date(Date.now() - 30 * 60 * 1000),
          },
        },
      }),
      this.prisma.photo.count({
        where: { status: 'FAILED' }
      }),
      this.prisma.photo.count({
        where: {
          status: 'PENDING',
          createdAt: {
            lt: new Date(Date.now() - 10 * 60 * 1000),
          },
        },
      }),
    ]);

    return {
      stuckBatches,
      failedPhotos,
      pendingPhotos,
      timestamp: new Date().toISOString(),
    };
  }
}