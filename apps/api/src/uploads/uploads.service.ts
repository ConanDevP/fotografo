import { Injectable, BadRequestException, NotFoundException, ForbiddenException, Logger } from '@nestjs/common';
import { PrismaService } from '../common/services/prisma.service';
import { StorageService } from '../common/services/storage.service';
import { QueueService } from '../common/services/queue.service';
import { JobRecoveryService } from '../common/services/job-recovery.service';
import { FILE_CONSTRAINTS, ERROR_CODES } from '@shared/constants';
import { UserRole } from '@shared/types';
import { getErrorMessage } from '@shared/utils';
import { InitiateBatchUploadDto } from './dto/initiate-batch-upload.dto';
import { BatchStatusDetailed, ProcessingPerformance, UserDashboardStats } from './dto/batch-status-detailed.dto';


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

  async getBatchUploadStatusDetailed(jobId: string, userId: string): Promise<BatchStatusDetailed> {
    const job = await this.prisma.batchUploadJob.findUnique({
      where: { id: jobId },
      include: {
        event: { select: { name: true } },
        photos: {
          select: {
            id: true,
            status: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'desc' }
        }
      }
    });

    if (!job) {
      throw new NotFoundException({ 
        code: ERROR_CODES.JOB_NOT_FOUND, 
        message: 'Lote de subida no encontrado' 
      });
    }

    if (job.ownerId !== userId) {
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'No tienes permisos para ver el estado de este lote',
      });
    }

    // Calculate progress metrics
    const totalFiles = job.totalFiles;
    const uploadProgress = totalFiles > 0 ? (job.uploadedFiles / totalFiles) * 100 : 0;
    const processingProgress = totalFiles > 0 ? (job.processedFiles / totalFiles) * 100 : 0;
    const progressPercentage = Math.round((uploadProgress + processingProgress) / 2);

    // Calculate processing speed
    const startTime = job.createdAt.getTime();
    const currentTime = Date.now();
    const elapsedMinutes = (currentTime - startTime) / (1000 * 60);
    const processingSpeed = elapsedMinutes > 0 ? job.processedFiles / elapsedMinutes : 0;

    // Estimate completion time
    const remainingFiles = totalFiles - job.processedFiles;
    const estimatedMinutesRemaining = processingSpeed > 0 ? remainingFiles / processingSpeed : null;
    const estimatedCompletion = estimatedMinutesRemaining 
      ? new Date(currentTime + estimatedMinutesRemaining * 60 * 1000).toISOString()
      : undefined;

    // Determine current step
    let currentStep = 'Iniciando';
    if (job.status === 'UPLOADING') currentStep = 'Subiendo archivos';
    else if (job.status === 'PROCESSING') currentStep = 'Procesando imágenes';
    else if (job.status === 'COMPLETED') currentStep = 'Completado';
    else if (job.status === 'FAILED') currentStep = 'Error';

    // Check if stuck (no updates in 15 minutes while processing)
    const isStuck = job.status === 'PROCESSING' && 
      (currentTime - job.updatedAt.getTime()) > 15 * 60 * 1000;

    // Get recent errors (simplified - get failed photos count)
    const failedPhotos = job.photos.filter(p => p.status === 'FAILED');
    const recentFailedPhotos = failedPhotos
      .slice(0, 10)
      .map(p => ({
        photoId: p.id,
        step: 'Procesamiento',
        error: 'Error en procesamiento de imagen',
        timestamp: p.createdAt.toISOString()
      }));

    // Calculate throughput (simplified - use processed files)
    const last5minPhotos = Math.min(job.processedFiles, 50); // Estimate based on recent activity
    const last15minPhotos = Math.min(job.processedFiles, 150);

    // Determine bottleneck
    let bottleneck = 'Ninguno';
    if (job.failedWatermarks > job.watermarkFiles * 0.1) bottleneck = 'Generación de watermarks';
    else if (job.failedGemini > job.geminiFiles * 0.1) bottleneck = 'OCR Gemini';
    else if (job.failedFaces > job.faceFiles * 0.1) bottleneck = 'Reconocimiento facial';
    else if (processingSpeed < 1) bottleneck = 'Velocidad general';

    return {
      id: job.id,
      status: job.status,
      totalFiles: job.totalFiles,
      uploadedFiles: job.uploadedFiles,
      processedFiles: job.processedFiles,
      
      watermarkFiles: job.watermarkFiles,
      geminiFiles: job.geminiFiles,
      faceFiles: job.faceFiles,
      failedWatermarks: job.failedWatermarks,
      failedGemini: job.failedGemini,
      failedFaces: job.failedFaces,
      
      progressPercentage,
      uploadProgress: Math.round(uploadProgress),
      processingProgress: Math.round(processingProgress),
      
      startedAt: job.createdAt.toISOString(),
      estimatedCompletion,
      processingSpeed: Math.round(processingSpeed * 100) / 100,
      
      currentStep,
      isStuck,
      
      recentErrors: recentFailedPhotos,
      
      avgProcessingTime: processingSpeed > 0 ? Math.round(60 / processingSpeed) : 0, // seconds per photo
      bottleneck,
      throughput: {
        last5min: last5minPhotos,
        last15min: last15minPhotos,
        overall: Math.round(processingSpeed * 60) // photos per hour
      }
    };
  }

  async getProcessingPerformance(jobId: string, userId: string): Promise<ProcessingPerformance> {
    const job = await this.prisma.batchUploadJob.findUnique({
      where: { id: jobId },
      include: {
        photos: {
          select: {
            id: true,
            status: true,
            createdAt: true,
          }
        }
      }
    });

    if (!job) {
      throw new NotFoundException({ 
        code: ERROR_CODES.JOB_NOT_FOUND, 
        message: 'Lote de subida no encontrado' 
      });
    }

    if (job.ownerId !== userId) {
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'No tienes permisos para ver el rendimiento de este lote',
      });
    }

    const startTime = job.createdAt.getTime();
    const currentTime = Date.now();
    const totalDuration = Math.round((currentTime - startTime) / 1000); // seconds

    const processedPhotos = job.photos.filter(p => p.status === 'PROCESSED');
    const avgTimePerPhoto = processedPhotos.length > 0 ? totalDuration / processedPhotos.length : 0;
    
    const currentSpeed = totalDuration > 0 ? (job.processedFiles / totalDuration) * 60 : 0; // per minute
    const remainingFiles = job.totalFiles - job.processedFiles;
    const estimatedTimeRemaining = currentSpeed > 0 ? Math.round(remainingFiles / currentSpeed) : 0; // minutes

    // Estimate pipeline performance (simplified)
    const pipelinePerformance = {
      upload: {
        avgTime: 2, // seconds
        success: job.uploadedFiles,
        failed: Math.max(0, job.totalFiles - job.uploadedFiles)
      },
      watermark: {
        avgTime: 3, // seconds
        success: job.watermarkFiles,
        failed: job.failedWatermarks
      },
      ocr: {
        avgTime: 5, // seconds
        success: job.geminiFiles,
        failed: job.failedGemini
      },
      faceDetection: {
        avgTime: 2, // seconds
        success: job.faceFiles,
        failed: job.failedFaces
      }
    };

    // Identify bottlenecks
    const bottlenecks = [
      { step: 'watermark', avgTime: 3, impact: (job.failedWatermarks > 5 ? 'high' : 'low') as 'high' | 'medium' | 'low' },
      { step: 'ocr', avgTime: 5, impact: (job.failedGemini > 5 ? 'high' : 'medium') as 'high' | 'medium' | 'low' },
      { step: 'faceDetection', avgTime: 2, impact: (job.failedFaces > 5 ? 'medium' : 'low') as 'high' | 'medium' | 'low' }
    ].filter(b => b.impact !== 'low');

    return {
      batchId: job.id,
      totalDuration,
      avgTimePerPhoto: Math.round(avgTimePerPhoto),
      currentSpeed: Math.round(currentSpeed * 100) / 100,
      estimatedTimeRemaining,
      pipelinePerformance,
      bottlenecks
    };
  }

  async getUserDashboardStats(userId: string): Promise<UserDashboardStats> {
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const [totalBatches, recentBatches, monthlyStats, totalPhotos, processedPhotos] = await Promise.all([
      // Total batches
      this.prisma.batchUploadJob.count({
        where: { ownerId: userId }
      }),

      // Recent batches with event info
      this.prisma.batchUploadJob.findMany({
        where: { ownerId: userId },
        include: {
          event: { select: { name: true } }
        },
        orderBy: { createdAt: 'desc' },
        take: 10
      }),

      // Monthly stats
      this.prisma.batchUploadJob.aggregate({
        where: {
          ownerId: userId,
          createdAt: { gte: startOfMonth }
        },
        _count: { id: true },
        _sum: { 
          totalFiles: true,
          processedFiles: true 
        }
      }),

      // Total photos uploaded
      this.prisma.photo.count({
        where: { photographerId: userId }
      }),

      // Total photos processed
      this.prisma.photo.count({
        where: { 
          photographerId: userId,
          status: 'PROCESSED'
        }
      })
    ]);

    // Calculate success rate and avg processing time
    const successRate = totalPhotos > 0 ? (processedPhotos / totalPhotos) * 100 : 0;
    const totalErrors = totalPhotos - processedPhotos;

    // Calculate average processing time (simplified)
    const completedBatches = recentBatches.filter(b => b.status === 'COMPLETED');
    const avgProcessingTime = completedBatches.length > 0 
      ? completedBatches.reduce((sum, batch) => {
          const duration = batch.updatedAt.getTime() - batch.createdAt.getTime();
          return sum + (duration / batch.totalFiles); // ms per photo
        }, 0) / completedBatches.length / 1000 // convert to seconds
      : 0;

    return {
      totalBatches,
      totalPhotosUploaded: totalPhotos,
      totalPhotosProcessed: processedPhotos,

      recentBatches: recentBatches.map(batch => ({
        id: batch.id,
        eventName: batch.event?.name || 'Evento sin nombre',
        status: batch.status,
        totalFiles: batch.totalFiles,
        processedFiles: batch.processedFiles,
        createdAt: batch.createdAt.toISOString(),
        completedAt: batch.status === 'COMPLETED' ? batch.updatedAt.toISOString() : undefined
      })),

      processingStats: {
        avgProcessingTime: Math.round(avgProcessingTime),
        successRate: Math.round(successRate * 100) / 100,
        totalErrors
      },

      currentMonth: {
        batchesCreated: monthlyStats._count.id,
        photosUploaded: monthlyStats._sum.totalFiles || 0,
        photosProcessed: monthlyStats._sum.processedFiles || 0
      }
    };
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

    // SEGURIDAD: Procesar en chunks para evitar sobrecarga con 3000+ fotos
    const CHUNK_SIZE = parseInt(process.env.MAX_UPLOAD_CHUNK_SIZE || '50');
    
    for (let i = 0; i < files.length; i += CHUNK_SIZE) {
      const chunk = files.slice(i, i + CHUNK_SIZE);
      this.logger.log(`Procesando chunk ${Math.floor(i / CHUNK_SIZE) + 1}/${Math.ceil(files.length / CHUNK_SIZE)} (${chunk.length} archivos)`);
      
      const chunkPromises = chunk.map(async (file) => {
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

      // Pausa entre chunks para no saturar el sistema
      if (i + CHUNK_SIZE < files.length) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

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

  async forceProcessStuckPhotos() {
    try {
      // Delegar a JobRecoveryService que ya tiene esta funcionalidad
      const result = await this.jobRecoveryService.forceProcessStuckPhotos();
      
      this.logger.log(`Procesamiento forzado iniciado: ${result.processed} fotos re-encoladas`);
      
      return {
        message: 'Procesamiento forzado iniciado',
        photosReprocessed: result.processed,
        details: result
      };
    } catch (error) {
      this.logger.error(`Error en procesamiento forzado: ${getErrorMessage(error)}`);
      throw new BadRequestException({
        code: ERROR_CODES.INTERNAL_ERROR,
        message: 'Error iniciando procesamiento forzado',
        details: getErrorMessage(error),
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
