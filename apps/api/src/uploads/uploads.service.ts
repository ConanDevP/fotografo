import { Injectable, BadRequestException, NotFoundException, ForbiddenException, Logger } from '@nestjs/common';
import { PrismaService } from '../common/services/prisma.service';
import { StorageService } from '../common/services/storage.service';
import { QueueService } from '../common/services/queue.service';
import { JobRecoveryService } from '../common/services/job-recovery.service';
import { FILE_CONSTRAINTS, ERROR_CODES } from '@shared/constants';
import { UserRole } from '@shared/types';
import { getErrorMessage } from '@shared/utils';
import { InitiateBatchUploadDto } from './dto/initiate-batch-upload.dto';


@Injectable()
export class UploadsService {
  private readonly logger = new Logger(UploadsService.name);
  
  constructor(
    private prisma: PrismaService,
    private storageService: StorageService,
    private queueService: QueueService,
    private jobRecoveryService: JobRecoveryService,
  ) {}

  async initiateBatchUpload(initiateDto: InitiateBatchUploadDto, ownerId: string) {
    // Optional: Check if event exists
    const event = await this.prisma.event.findUnique({ where: { id: initiateDto.eventId } });
    if (!event) {
      throw new NotFoundException({
        code: ERROR_CODES.EVENT_NOT_FOUND,
        message: 'Evento no encontrado',
      });
    }

    const job = await this.prisma.batchUploadJob.create({
      data: {
        eventId: initiateDto.eventId,
        ownerId: ownerId,
        totalFiles: initiateDto.totalFiles,
        status: 'PENDING',
      },
    });

    return job;
  }

  async appendToBatchUpload(
    jobId: string,
    files: Express.Multer.File[],
    userId: string,
    userRole: UserRole,
  ) {
    const job = await this.prisma.batchUploadJob.findUnique({ where: { id: jobId } });
    if (!job) {
      throw new NotFoundException({ code: ERROR_CODES.JOB_NOT_FOUND, message: 'Lote de subida no encontrado' });
    }

    if (job.ownerId !== userId) {
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'No tienes permisos para añadir archivos a este lote',
      });
    }

    if (job.status === 'COMPLETED' || job.status === 'FAILED') {
        throw new BadRequestException({ code: ERROR_CODES.JOB_COMPLETED, message: 'Este lote de subida ya ha sido completado o ha fallado.' });
    }

    // Set status to uploading if it's the first chunk
    if (job.status === 'PENDING') {
        await this.prisma.batchUploadJob.update({ where: { id: jobId }, data: { status: 'UPLOADING' } });
    }

    const results = [];
    const errors = [];

    const chunkPromises = files.map(async (file) => {
      try {
        const result = await this.uploadPhoto(file, job.eventId, userId, userRole, { batchJobId: jobId });
        return { success: true, result, fileName: file.originalname };
      } catch (error) {
        return {
          success: false,
          error: {
            fileName: file.originalname,
            error: getErrorMessage(error),
          },
        };
      }
    });

    const chunkResults = await Promise.all(chunkPromises);

    chunkResults.forEach(r => (r.success ? results.push(r.result) : errors.push(r.error)));

    // Update uploaded files count
    const updatedJob = await this.prisma.batchUploadJob.update({
        where: { id: jobId },
        data: { uploadedFiles: { increment: results.length } },
    });

    // If all files are uploaded, mark as processing
    if (updatedJob.uploadedFiles >= updatedJob.totalFiles) {
        await this.prisma.batchUploadJob.update({ where: { id: jobId }, data: { status: 'PROCESSING' } });
    }

    return {
      successful: results,
      errors,
      totalInChunk: files.length,
      jobStatus: updatedJob
    };
  }

  async getBatchUploadStatus(jobId: string, userId: string) {
    const job = await this.prisma.batchUploadJob.findUnique({ where: { id: jobId } });

    if (!job) {
      throw new NotFoundException({ code: ERROR_CODES.JOB_NOT_FOUND, message: 'Lote de subida no encontrado' });
    }

    if (job.ownerId !== userId) {
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'No tienes permisos para ver el estado de este lote',
      });
    }

    return job;
  }

  async uploadPhoto(
    file: Express.Multer.File,
    eventId: string,
    userId: string,
    userRole: UserRole,
    metadata?: {
      takenAt?: string;
      batchJobId?: string;
    },
  ) {
    // Validate file
    this.validateFile(file);

    // Check if event exists and user has permission
    const event = await this.prisma.event.findUnique({
      where: { id: eventId },
    });

    if (!event) {
      throw new NotFoundException({
        code: ERROR_CODES.EVENT_NOT_FOUND,
        message: 'Evento no encontrado',
      });
    }

    // Check permissions
    if (userRole !== UserRole.ADMIN && event.ownerId !== userId) {
      throw new BadRequestException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'No tienes permisos para subir fotos a este evento',
      });
    }

    // Create photo record first
    const photo = await this.prisma.photo.create({
      data: {
        eventId,
        photographerId: userId,
        batchJobId: metadata?.batchJobId, // Associate with batch job
        cloudinaryId: 'temp', // Will be updated after upload
        originalUrl: 'temp',
        takenAt: metadata?.takenAt ? new Date(metadata.takenAt) : null,
        status: 'PENDING',
      },
    });

    try {
      // Upload to Storage (R2 or Cloudinary)
      const uploadResult = await this.storageService.uploadPhoto(file, eventId, photo.id);

      // Update photo with storage data
      const updatedPhoto = await this.prisma.photo.update({
        where: { id: photo.id },
        data: {
          cloudinaryId: uploadResult.cloudinaryId,
          originalUrl: uploadResult.originalUrl,
          width: uploadResult.width,
          height: uploadResult.height,
        },
      });


      // Enqueue photo for processing with retry
      try {
        await this.queueService.addProcessPhotoJob({
          photoId: updatedPhoto.id,
          eventId: eventId,
          objectKey: uploadResult.cloudinaryId,
        });
        
        this.logger.log(`Job encolado para foto ${updatedPhoto.id}`);
      } catch (error) {
        this.logger.error(`Error encolando job para foto ${updatedPhoto.id}: ${getErrorMessage(error)}`);
        
        // Retry inmediato una vez
        try {
          await this.queueService.addProcessPhotoJob({
            photoId: updatedPhoto.id,
            eventId: eventId,
            objectKey: uploadResult.cloudinaryId,
          });
          this.logger.log(`Job re-encolado exitosamente para foto ${updatedPhoto.id}`);
        } catch (retryError) {
          this.logger.error(`FALLÓ retry para foto ${updatedPhoto.id}: ${getErrorMessage(retryError)}`);
          // No fallar la subida por esto, pero marcar foto como fallida
          await this.prisma.photo.update({
            where: { id: updatedPhoto.id },
            data: { status: 'FAILED' }
          });
        }
      }

      
      return {
        photoId: updatedPhoto.id,
        cloudinaryId: uploadResult.cloudinaryId,
        originalUrl: uploadResult.originalUrl,
        width: uploadResult.width,
        height: uploadResult.height,
      };
    } catch (error) {
      // If upload fails, delete the photo record
      await this.prisma.photo.delete({
        where: { id: photo.id },
      });
      
      throw new BadRequestException({
        code: ERROR_CODES.UPLOAD_FAILED,
        message: 'Error al subir la foto',
        details: getErrorMessage(error),
      });
    }
  }

  async reprocessPhoto(photoId: string, userId: string, userRole: UserRole) {
    // Buscar foto
    const photo = await this.prisma.photo.findUnique({
      where: { id: photoId },
      include: { event: true }
    });

    if (!photo) {
      throw new NotFoundException({
        code: ERROR_CODES.PHOTO_NOT_FOUND,
        message: 'Foto no encontrada',
      });
    }

    // Verificar permisos
    if (userRole !== UserRole.ADMIN && photo.event.ownerId !== userId) {
      throw new BadRequestException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'No tienes permisos para reprocesar esta foto',
      });
    }

    // Marcar como pendiente y re-encolar
    await this.prisma.photo.update({
      where: { id: photoId },
      data: { status: 'PENDING' }
    });

    try {
      await this.queueService.addProcessPhotoJob({
        photoId: photo.id,
        eventId: photo.eventId,
        objectKey: photo.cloudinaryId,
      }, 10); // Alta prioridad
      
      this.logger.log(`Foto ${photoId} re-encolada para reprocesamiento`);
      
      return { message: 'Foto encolada para reprocesamiento', photoId };
    } catch (error) {
      this.logger.error(`Error re-encolando foto ${photoId}: ${getErrorMessage(error)}`);
      throw new BadRequestException({
        code: ERROR_CODES.INTERNAL_ERROR,
        message: 'Error encolando foto para reprocesamiento',
      });
    }
  }

  async getSystemStats() {
    try {
      // Obtener estadísticas de recovery
      const recoveryStats = await this.jobRecoveryService.getRecoveryStats();

      // Estadísticas adicionales del sistema
      const [activeJobs, recentBatches, photosByStatus] = await Promise.all([
        // BatchJobs activos con estadísticas detalladas del pipeline
        this.prisma.batchUploadJob.findMany({
          where: {
            status: { in: ['PENDING', 'UPLOADING', 'PROCESSING'] }
          },
          select: {
            id: true,
            status: true,
            totalFiles: true,
            uploadedFiles: true,
            processedFiles: true,
            watermarkFiles: true,
            geminiFiles: true,
            faceFiles: true,
            failedWatermarks: true,
            failedGemini: true,
            failedFaces: true,
            createdAt: true,
            updatedAt: true,
          },
          orderBy: { createdAt: 'desc' },
          take: 10,
        }),

        // BatchJobs recientes (últimas 24 horas) con estadísticas del pipeline
        this.prisma.batchUploadJob.findMany({
          where: {
            createdAt: {
              gte: new Date(Date.now() - 24 * 60 * 60 * 1000)
            }
          },
          select: {
            id: true,
            status: true,
            totalFiles: true,
            processedFiles: true,
            watermarkFiles: true,
            geminiFiles: true,
            faceFiles: true,
            failedWatermarks: true,
            failedGemini: true,
            failedFaces: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'desc' },
          take: 20,
        }),

        // Fotos por estado
        this.prisma.photo.groupBy({
          by: ['status'],
          where: {
            createdAt: {
              gte: new Date(Date.now() - 24 * 60 * 60 * 1000)
            }
          },
          _count: {
            id: true
          }
        })
      ]);

      // Calcular estadísticas de performance con métricas detalladas del pipeline
      const batchStats = recentBatches.reduce((acc, batch) => {
        acc.total += 1;
        acc.totalFiles += batch.totalFiles;
        acc.processedFiles += batch.processedFiles;
        
        // Pipeline stats
        acc.watermarkFiles += batch.watermarkFiles;
        acc.geminiFiles += batch.geminiFiles;
        acc.faceFiles += batch.faceFiles;
        acc.failedWatermarks += batch.failedWatermarks;
        acc.failedGemini += batch.failedGemini;
        acc.failedFaces += batch.failedFaces;
        
        if (batch.status === 'COMPLETED') acc.completed += 1;
        else if (batch.status === 'FAILED') acc.failed += 1;
        else acc.active += 1;

        return acc;
      }, { 
        total: 0, 
        completed: 0, 
        failed: 0, 
        active: 0, 
        totalFiles: 0, 
        processedFiles: 0,
        watermarkFiles: 0,
        geminiFiles: 0,
        faceFiles: 0,
        failedWatermarks: 0,
        failedGemini: 0,
        failedFaces: 0
      });

      // Convertir photosByStatus a objeto
      const statusCounts = photosByStatus.reduce((acc, item) => {
        acc[item.status] = item._count.id;
        return acc;
      }, {} as Record<string, number>);

      return {
        recovery: recoveryStats,
        batches: {
          active: activeJobs,
          stats24h: {
            total: batchStats.total,
            completed: batchStats.completed,
            failed: batchStats.failed,
            active: batchStats.active,
            totalFiles: batchStats.totalFiles,
            processedFiles: batchStats.processedFiles,
            successRate: batchStats.total > 0 ? ((batchStats.completed / batchStats.total) * 100).toFixed(1) : '0.0',
          }
        },
        pipeline: {
          watermarks: {
            processed: batchStats.watermarkFiles,
            failed: batchStats.failedWatermarks,
            successRate: batchStats.totalFiles > 0 ? (((batchStats.watermarkFiles) / batchStats.totalFiles) * 100).toFixed(1) : '0.0',
          },
          gemini: {
            processed: batchStats.geminiFiles,
            failed: batchStats.failedGemini,
            successRate: batchStats.watermarkFiles > 0 ? ((batchStats.geminiFiles / batchStats.watermarkFiles) * 100).toFixed(1) : '0.0',
          },
          faces: {
            processed: batchStats.faceFiles,
            failed: batchStats.failedFaces,
            successRate: batchStats.geminiFiles > 0 ? ((batchStats.faceFiles / batchStats.geminiFiles) * 100).toFixed(1) : '0.0',
          },
          overall: {
            totalSteps: batchStats.totalFiles * 3, // 3 steps per photo
            completedSteps: batchStats.watermarkFiles + batchStats.geminiFiles + batchStats.faceFiles,
            failedSteps: batchStats.failedWatermarks + batchStats.failedGemini + batchStats.failedFaces,
            efficiency: batchStats.totalFiles > 0 ? (((batchStats.watermarkFiles + batchStats.geminiFiles + batchStats.faceFiles) / (batchStats.totalFiles * 3)) * 100).toFixed(1) : '0.0',
          }
        },
        photos: {
          statusCounts,
          total24h: Object.values(statusCounts).reduce((a, b) => a + b, 0),
        },
        timestamp: new Date().toISOString(),
      };

    } catch (error) {
      this.logger.error(`Error obteniendo estadísticas del sistema: ${getErrorMessage(error)}`);
      throw new BadRequestException({
        code: ERROR_CODES.INTERNAL_ERROR,
        message: 'Error obteniendo estadísticas del sistema',
      });
    }
  }

  /*
  async uploadPhotoBatch(
    files: Express.Multer.File[],
    eventId: string,
    userId: string,
    userRole: UserRole,
  ) {
    const results = [];
    const errors = [];
    const CHUNK_SIZE = 10; // Procesar de 10 en 10 para evitar sobrecarga de DB

    // Procesar en chunks
    for (let i = 0; i < files.length; i += CHUNK_SIZE) {
      const chunk = files.slice(i, i + CHUNK_SIZE);
      console.log(`Procesando chunk ${Math.floor(i / CHUNK_SIZE) + 1}/${Math.ceil(files.length / CHUNK_SIZE)} (${chunk.length} fotos)`);
      
      // Procesar chunk con Promise.all para paralelizar
      const chunkPromises = chunk.map(async (file, chunkIndex) => {
        const globalIndex = i + chunkIndex;
        try {
          const result = await this.uploadPhoto(file, eventId, userId, userRole);
          return { success: true, result, globalIndex, fileName: file.originalname };
        } catch (error) {
          return { 
            success: false, 
            error: {
              fileIndex: globalIndex,
              fileName: file.originalname,
              error: getErrorMessage(error),
            }
          };
        }
      });

      // Esperar que termine el chunk completo
      const chunkResults = await Promise.all(chunkPromises);
      
      // Procesar resultados del chunk
      chunkResults.forEach(result => {
        if (result.success) {
          results.push(result.result);
        } else {
          errors.push(result.error);
        }
      });

      // Pequeña pausa entre chunks para no sobrecargar el sistema
      if (i + CHUNK_SIZE < files.length) {
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }

    console.log(`Batch completado: ${results.length} exitosas, ${errors.length} fallidas`);

    return {
      successful: results,
      errors,
      total: files.length,
      successCount: results.length,
      errorCount: errors.length,
    };
  }
  */

  private validateFile(file: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException({
        code: ERROR_CODES.VALIDATION_ERROR,
        message: 'No se proporcionó archivo',
      });
    }

    // Check file size
    if (file.size > FILE_CONSTRAINTS.MAX_SIZE) {
      throw new BadRequestException({
        code: ERROR_CODES.PHOTO_TOO_LARGE,
        message: `Archivo muy grande. Máximo ${FILE_CONSTRAINTS.MAX_SIZE / (1024 * 1024)}MB`,
      });
    }

    // Check file type
    if (!FILE_CONSTRAINTS.ALLOWED_TYPES.includes(file.mimetype)) {
      throw new BadRequestException({
        code: ERROR_CODES.INVALID_PHOTO_FORMAT,
        message: 'Formato de archivo no válido. Usa JPG o PNG',
      });
    }

    // Check file extension
    const extension = file.originalname.toLowerCase().split('.').pop();
    if (!FILE_CONSTRAINTS.ALLOWED_EXTENSIONS.some(ext => ext === `.${extension}`)) {
      throw new BadRequestException({
        code: ERROR_CODES.INVALID_PHOTO_FORMAT,
        message: 'Extensión de archivo no válida',
      });
    }
  }
}
