import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from './prisma.service';
import { QueueService } from './queue.service';
import { StorageService } from './storage.service';

@Injectable()
export class JobRecoveryService {
  private readonly logger = new Logger(JobRecoveryService.name);

  constructor(
    private prisma: PrismaService,
    private queueService: QueueService,
    private storageService: StorageService,
  ) {}

  /**
   * Una foto "PENDING" hace rato pudo quedarse así por dos motivos muy
   * distintos: el job de proceso se perdió de la cola (el objeto SÍ está en
   * R2, re-encolar la arregla), o el chunk de subida falló a medias y
   * `/uploads/batch/:id/complete` nunca llegó a confirmarla (el objeto NO
   * existe en R2, y re-encolarla solo la manda derecho a FAILED).
   *
   * Sin esta comprobación, este mismo recovery era el que convertía subidas
   * fallidas en fotografías fantasma con badge de error en el dashboard.
   */
  private async recoverOrDiscard(
    photo: { id: string; eventId: string; cloudinaryId: string },
    priority: number,
    context: string,
  ): Promise<'recovered' | 'discarded' | 'error'> {
    try {
      const head = await this.storageService.headUploadedPhoto(photo.cloudinaryId).catch(() => null);
      if (!head || head.size <= 0) {
        // Nunca llegó a subirse: no hay nada que procesar. Se borra en vez de
        // dejarla en PENDING para siempre o mandarla a fallar en el worker.
        await this.prisma.photo.delete({ where: { id: photo.id } }).catch(() => undefined);
        this.logger.warn(
          `${context}: foto ${photo.id} no tiene objeto en almacenamiento (${photo.cloudinaryId}), descartada`,
        );
        return 'discarded';
      }

      await this.queueService.addProcessPhotoJob(
        { photoId: photo.id, eventId: photo.eventId, objectKey: photo.cloudinaryId },
        priority,
      );
      this.logger.log(`${context}: foto ${photo.id} re-encolada (objeto verificado en almacenamiento)`);
      return 'recovered';
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`${context}: error verificando/re-encolando foto ${photo.id}: ${errorMsg}`);
      return 'error';
    }
  }

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
      let discardedCount = 0;
      const errors: string[] = [];

      for (const photo of stuckPhotos) {
        const outcome = await this.recoverOrDiscard(photo, 20, 'Recovery'); // Alta prioridad
        if (outcome === 'recovered') recoveredCount++;
        else if (outcome === 'discarded') discardedCount++;
        else errors.push(photo.id);
      }

      this.logger.log(
        `Recovery completado: ${recoveredCount} fotos re-encoladas, ${discardedCount} descartadas (nunca subidas), ${errors.length} errores`,
      );

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

        // Re-encolar fotos pendientes (o descartar las que nunca llegaron a subirse)
        let reEnqueued = 0;
        let discarded = 0;
        for (const photo of pendingPhotos) {
          const outcome = await this.recoverOrDiscard(photo, 15, `BatchJob ${batchJob.id}`); // Prioridad alta
          if (outcome === 'recovered') reEnqueued++;
          else if (outcome === 'discarded') discarded++;
        }

        // Actualizar timestamp del batch job
        await this.prisma.batchUploadJob.update({
          where: { id: batchJob.id },
          data: { updatedAt: new Date() }
        });

        this.logger.log(
          `BatchJob ${batchJob.id}: ${reEnqueued}/${pendingPhotos.length} fotos re-encoladas, ${discarded} descartadas`,
        );
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