import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/services/prisma.service';
import { CloudinaryService } from '../common/services/cloudinary.service';
import { QueueService } from '../common/services/queue.service';
import { FILE_CONSTRAINTS, ERROR_CODES } from '@shared/constants';
import { UserRole } from '@shared/types';
import { getErrorMessage } from '@shared/utils';


@Injectable()
export class UploadsService {
  constructor(
    private prisma: PrismaService,
    private cloudinaryService: CloudinaryService,
    private queueService: QueueService,
  ) {}

  async uploadPhoto(
    file: Express.Multer.File,
    eventId: string,
    userId: string,
    userRole: UserRole,
    metadata?: {
      takenAt?: string;
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
        cloudinaryId: 'temp', // Will be updated after upload
        originalUrl: 'temp',
        takenAt: metadata?.takenAt ? new Date(metadata.takenAt) : null,
        status: 'PENDING',
      },
    });

    try {
      // Upload to Cloudinary
      const uploadResult = await this.cloudinaryService.uploadPhoto(file, eventId, photo.id);

      // Update photo with Cloudinary data
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

  async uploadPhotoBatch(
    files: Express.Multer.File[],
    eventId: string,
    userId: string,
    userRole: UserRole,
  ) {
    const results = [];
    const errors = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      
      try {
        const result = await this.uploadPhoto(file, eventId, userId, userRole);
        results.push(result);
      } catch (error) {
        errors.push({
          fileIndex: i,
          fileName: file.originalname,
          error: getErrorMessage(error),
        });
      }
    }

    return {
      successful: results,
      errors,
      total: files.length,
      successCount: results.length,
      errorCount: errors.length,
    };
  }

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