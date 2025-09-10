import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from './prisma.service';
import { QueueService } from './queue.service';

@Injectable()
export class JobRecoveryService {
  private readonly logger = new Logger(JobRecoveryService.name);

  constructor(
    private prisma: PrismaService,
    private queueService: QueueService,
  ) {}

  // Ejecutar cada 2 minutos para detectar jobs stuck
  @Cron('*/2 * * * *')
  async recoverStuckPhotos() {
    try {
      this.logger.log('Iniciando recuperación de fotos stuck');

      // Buscar fotos que están PENDING por más de 10 minutos
      const stuckPhotos = await this.prisma.photo.findMany({
        where: {
          status: 'PENDING',
          createdAt: {
            lt: new Date(Date.now() - 10 * 60 * 1000), // 10 minutos atrás
          },
          // Solo fotos que tienen cloudinaryId (ya están subidas)
          cloudinaryId: {
            not: 'temp'
          }
        },
        select: {
          id: true,
          eventId: true,
          cloudinaryId: true,
          batchJobId: true,
          createdAt: true,
        },
        take: 50, // Limitar a 50 para no sobrecargar
      });

      if (stuckPhotos.length === 0) {
        this.logger.log('No se encontraron fotos stuck');
        return;
      }

      this.logger.warn(`Encontradas ${stuckPhotos.length} fotos stuck, iniciando recovery`);

      let recoveredCount = 0;
      const errors: string[] = [];

      for (const photo of stuckPhotos) {
        try {
          // Re-encolar job con alta prioridad
          await this.queueService.addProcessPhotoJob({
            photoId: photo.id,
            eventId: photo.eventId,
            objectKey: photo.cloudinaryId,
          }, 20); // Alta prioridad para recovery

          recoveredCount++;
          this.logger.log(`Recovery: Re-encolado job para foto ${photo.id} (stuck desde ${photo.createdAt})`);

        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          errors.push(`${photo.id}: ${errorMsg}`);
          this.logger.error(`Error en recovery para foto ${photo.id}: ${errorMsg}`);
        }
      }

      this.logger.log(`Recovery completado: ${recoveredCount} fotos re-encoladas, ${errors.length} errores`);

      if (errors.length > 0) {
        this.logger.warn(`Errores en recovery: ${errors.slice(0, 5).join(', ')}${errors.length > 5 ? '...' : ''}`);
      }

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Error desconocido';
      this.logger.error(`Error en servicio de recovery: ${errorMessage}`, error instanceof Error ? error.stack : undefined);
    }
  }

  // Recovery específico para BatchUploadJobs stuck
  @Cron('*/5 * * * *')
  async recoverStuckBatchJobs() {
    try {
      this.logger.log('Verificando BatchUploadJobs stuck');

      // Buscar batch jobs que están en PROCESSING pero sin actividad reciente
      const stuckBatchJobs = await this.prisma.batchUploadJob.findMany({
        where: {
          status: 'PROCESSING',
          updatedAt: {
            lt: new Date(Date.now() - 10 * 60 * 1000), // Sin updates por 10 minutos
          }
        },
        include: {
          photos: {
            where: {
              status: 'PENDING'
            },
            select: {
              id: true,
              eventId: true,
              cloudinaryId: true,
            },
            take: 100, // Máximo 100 fotos por batch para recovery
          }
        },
        take: 10, // Máximo 10 batch jobs por vez
      });

      if (stuckBatchJobs.length === 0) {
        this.logger.log('No se encontraron BatchUploadJobs stuck');
        return;
      }

      this.logger.warn(`Encontrados ${stuckBatchJobs.length} BatchUploadJobs stuck`);

      for (const batchJob of stuckBatchJobs) {
        const pendingPhotos = batchJob.photos.filter(p => p.cloudinaryId !== 'temp');
        
        if (pendingPhotos.length === 0) {
          // No hay fotos pendientes válidas, marcar como completado
          await this.prisma.batchUploadJob.update({
            where: { id: batchJob.id },
            data: { 
              status: 'COMPLETED',
              updatedAt: new Date()
            }
          });
          this.logger.log(`BatchJob ${batchJob.id} marcado como completado (no hay fotos pendientes)`);
          continue;
        }

        // Re-encolar fotos pendientes
        let reEnqueued = 0;
        for (const photo of pendingPhotos) {
          try {
            await this.queueService.addProcessPhotoJob({
              photoId: photo.id,
              eventId: photo.eventId,
              objectKey: photo.cloudinaryId,
            }, 15); // Prioridad alta para batch recovery

            reEnqueued++;
          } catch (error) {
            this.logger.error(`Error re-encolando foto ${photo.id} del batch ${batchJob.id}`);
          }
        }

        // Actualizar timestamp del batch job
        await this.prisma.batchUploadJob.update({
          where: { id: batchJob.id },
          data: { updatedAt: new Date() }
        });

        this.logger.log(`BatchJob ${batchJob.id}: Re-encoladas ${reEnqueued}/${pendingPhotos.length} fotos pendientes`);
      }

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Error desconocido';
      this.logger.error(`Error en recovery de batch jobs: ${errorMessage}`, error instanceof Error ? error.stack : undefined);
    }
  }

  // Método manual para recovery (para debugging)
  async forceRecoverPhoto(photoId: string): Promise<boolean> {
    try {
      const photo = await this.prisma.photo.findUnique({
        where: { id: photoId },
        select: {
          id: true,
          eventId: true,
          cloudinaryId: true,
          status: true,
        }
      });

      if (!photo) {
        throw new Error('Foto no encontrada');
      }

      if (photo.status === 'PROCESSED') {
        this.logger.warn(`Foto ${photoId} ya está procesada`);
        return false;
      }

      if (photo.cloudinaryId === 'temp') {
        throw new Error('Foto no ha sido subida correctamente');
      }

      await this.queueService.addProcessPhotoJob({
        photoId: photo.id,
        eventId: photo.eventId,
        objectKey: photo.cloudinaryId,
      }, 25); // Máxima prioridad para recovery manual

      this.logger.log(`Recovery manual: Foto ${photoId} re-encolada exitosamente`);
      return true;

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Error desconocido';
      this.logger.error(`Error en recovery manual de foto ${photoId}: ${errorMessage}`);
      throw error;
    }
  }

  // Forzar procesamiento de fotos stuck (para admin)
  async forceProcessStuckPhotos() {
    try {
      this.logger.log('Iniciando procesamiento forzado de fotos stuck');

      // Buscar fotos que están PENDING (independientemente del tiempo)
      const stuckPhotos = await this.prisma.photo.findMany({
        where: {
          status: 'PENDING',
          cloudinaryId: { not: 'temp' } // Solo fotos que están subidas
        },
        select: {
          id: true,
          eventId: true,
          cloudinaryId: true,
          batchJobId: true,
          createdAt: true,
        },
        take: 100, // Máximo 100 fotos por procesamiento forzado
      });

      if (stuckPhotos.length === 0) {
        this.logger.log('No se encontraron fotos stuck para procesar');
        return { processed: 0, errors: [] };
      }

      this.logger.log(`Procesamiento forzado: Encontradas ${stuckPhotos.length} fotos stuck`);

      let processedCount = 0;
      const errors: string[] = [];

      for (const photo of stuckPhotos) {
        try {
          await this.queueService.addProcessPhotoJob({
            photoId: photo.id,
            eventId: photo.eventId,
            objectKey: photo.cloudinaryId,
          }, 30); // Máxima prioridad para procesamiento forzado

          processedCount++;
          this.logger.log(`Forzado: Re-encolado job para foto ${photo.id}`);

        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          errors.push(`${photo.id}: ${errorMsg}`);
          this.logger.error(`Error en procesamiento forzado para foto ${photo.id}: ${errorMsg}`);
        }
      }

      this.logger.log(`Procesamiento forzado completado: ${processedCount} fotos re-encoladas, ${errors.length} errores`);

      return {
        processed: processedCount,
        total: stuckPhotos.length,
        errors,
        timestamp: new Date().toISOString(),
      };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Error desconocido';
      this.logger.error(`Error en procesamiento forzado: ${errorMessage}`, error instanceof Error ? error.stack : undefined);
      throw error;
    }
  }

  // Estadísticas del sistema
  async getRecoveryStats() {
    const [pendingPhotos, stuckBatchJobs, totalPhotos] = await Promise.all([
      this.prisma.photo.count({
        where: {
          status: 'PENDING',
          createdAt: {
            lt: new Date(Date.now() - 5 * 60 * 1000) // Más de 5 minutos
          },
          cloudinaryId: { not: 'temp' }
        }
      }),
      
      this.prisma.batchUploadJob.count({
        where: {
          status: 'PROCESSING',
          updatedAt: {
            lt: new Date(Date.now() - 10 * 60 * 1000)
          }
        }
      }),

      this.prisma.photo.count({
        where: {
          createdAt: {
            gte: new Date(Date.now() - 24 * 60 * 60 * 1000) // Últimas 24 horas
          }
        }
      })
    ]);

    return {
      pendingPhotos,
      stuckBatchJobs,
      totalPhotos24h: totalPhotos,
      lastCheck: new Date().toISOString(),
    };
  }
}