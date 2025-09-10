import { Injectable, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../common/services/prisma.service';
import { StorageService } from '../common/services/storage.service';
import { QueueService } from '../common/services/queue.service';
import { FILE_CONSTRAINTS, ERROR_CODES } from '@shared/constants';
import { UserRole } from '@shared/types';
import { getErrorMessage } from '@shared/utils';
import { InitiateBatchUploadDto } from './dto/initiate-batch-upload.dto';


@Injectable()
export class UploadsService {
  constructor(
    private prisma: PrismaService,
    private storageService: StorageService,
    private queueService: QueueService,
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


      // Enqueue photo for processing
      await this.queueService.addProcessPhotoJob({
        photoId: updatedPhoto.id,
        eventId: eventId,
        objectKey: uploadResult.cloudinaryId,
      });

      
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
