import {
  Controller,
  Post,
  Get,
  Param,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  UploadedFiles,
  Body,
  Req,
  BadRequestException,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import { Request } from 'express';
import { Throttle } from '@nestjs/throttler';

import { UploadsService } from './uploads.service';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { UploadPhotoDto } from './dto/upload-photo.dto';
import { InitiateBatchUploadDto } from './dto/initiate-batch-upload.dto';
import { CompleteBatchDto, PresignBatchDto } from './dto/presign-batch.dto';
import { UserRole, ApiResponse } from '@shared/types';
import { FILE_CONSTRAINTS } from '@shared/constants';

interface AuthenticatedRequest extends Request {
  user: {
    id: string;
    email: string;
    role: UserRole;
  };
}

@Controller('uploads')
@UseGuards(AuthGuard('jwt'))
export class UploadsController {
  constructor(private readonly uploadsService: UploadsService) {}

  @Post('batch/initiate')
  async initiateBatchUpload(
    @Body() initiateDto: InitiateBatchUploadDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<ApiResponse> {
    const job = await this.uploadsService.initiateBatchUpload(
      initiateDto,
      req.user.id,
      req.user.role,
    );
    return { data: { jobId: job.id } };
  }

  /**
   * Firma URLs para que el navegador suba directo a R2. El archivo no pasa por
   * la memoria del servidor, que era el techo de escalado del camino anterior.
   */
  @Post('batch/:jobId/presign')
  @Throttle(120, 60)
  async presignBatch(
    @Param('jobId') jobId: string,
    @Body() dto: PresignBatchDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<ApiResponse> {
    return {
      data: await this.uploadsService.presignBatchFiles(jobId, dto.files, req.user.id, req.user.role),
    };
  }

  /** Confirma lo que de verdad quedó en R2 y lo encola para procesar. */
  @Post('batch/:jobId/complete')
  @Throttle(120, 60)
  async completeBatch(
    @Param('jobId') jobId: string,
    @Body() dto: CompleteBatchDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<ApiResponse> {
    return {
      data: await this.uploadsService.completeBatchFiles(jobId, dto.clientFileIds, req.user.id),
    };
  }

  /**
   * Camino anterior: el archivo viaja por el servidor. Se mantiene mientras la
   * subida directa se asienta en producción; debería retirarse después.
   */
  @Post('batch/append/:jobId')
  // Una carrera son miles de fotografías: a 5 por petición, un límite bajo aquí
  // convierte una subida normal en horas. 240/min deja techo de sobra para
  // varios chunks en paralelo y sigue acotando el abuso. El gasto real lo
  // limitan el cupo de almacenamiento y el ancho de banda, no este contador.
  @Throttle(240, 60)
  @UseInterceptors(
    FilesInterceptor('files', 5, {
      limits: {
        fileSize: FILE_CONSTRAINTS.MAX_SIZE,
        files: 5,
        fieldSize: 64 * 1024,
        fields: 20,
      },
      fileFilter: (req, file, cb) => {
        if (FILE_CONSTRAINTS.ALLOWED_TYPES.includes(file.mimetype)) {
          cb(null, true);
        } else {
          cb(new BadRequestException('Tipo de archivo no válido'), false);
        }
      },
    }),
  )
  async appendToBatchUpload(
    @Param('jobId') jobId: string,
    @UploadedFiles() files: Express.Multer.File[],
    @Body('clientFileIds') rawClientFileIds: string | string[] | undefined,
    @Req() req: AuthenticatedRequest,
  ): Promise<ApiResponse> {
    if (!files || files.length === 0) {
      throw new BadRequestException('No se proporcionaron archivos en el chunk');
    }

    const clientFileIds = rawClientFileIds === undefined
      ? undefined
      : Array.isArray(rawClientFileIds)
        ? rawClientFileIds
        : [rawClientFileIds];

    if (clientFileIds && clientFileIds.length !== files.length) {
      throw new BadRequestException('Cada archivo debe incluir un clientFileId estable');
    }

    const result = await this.uploadsService.appendToBatchUpload(
      jobId,
      files,
      req.user.id,
      req.user.role,
      clientFileIds,
    );
    return { data: result };
  }

  @Get('batch/status/:jobId')
  async getBatchUploadStatus(
    @Param('jobId') jobId: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<ApiResponse> {
    const status = await this.uploadsService.getBatchUploadStatus(
      jobId,
      req.user.id,
    );
    return { data: status };
  }

  @Get('batch/status/:jobId/detailed')
  async getBatchUploadStatusDetailed(
    @Param('jobId') jobId: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<ApiResponse> {
    const status = await this.uploadsService.getBatchUploadStatusDetailed(
      jobId,
      req.user.id,
    );
    return { data: status };
  }

  @Get('batch/:jobId/performance')
  async getProcessingPerformance(
    @Param('jobId') jobId: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<ApiResponse> {
    const performance = await this.uploadsService.getProcessingPerformance(
      jobId,
      req.user.id,
    );
    return { data: performance };
  }

  @Get('user/dashboard')
  async getUserDashboardStats(
    @Req() req: AuthenticatedRequest,
  ): Promise<ApiResponse> {
    const stats = await this.uploadsService.getUserDashboardStats(req.user.id);
    return { data: stats };
  }

  @Post('reprocess/:photoId')
  async reprocessPhoto(
    @Param('photoId') photoId: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<ApiResponse> {
    const result = await this.uploadsService.reprocessPhoto(
      photoId,
      req.user.id,
      req.user.role,
    );
    return { data: result };
  }

  @Get('system/stats')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN) // Solo admins pueden ver stats del sistema
  async getSystemStats(): Promise<ApiResponse> {
    const stats = await this.uploadsService.getSystemStats();
    return { data: stats };
  }

  @Post('system/force-process')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN) // Solo admins pueden forzar procesamiento
  async forceProcessStuckPhotos(): Promise<ApiResponse> {
    const result = await this.uploadsService.forceProcessStuckPhotos();
    return { data: result };
  }

  @Post('photo')
  @Throttle(20, 60)
  @UseInterceptors(
    FileInterceptor('file', {
      limits: {
        fileSize: FILE_CONSTRAINTS.MAX_SIZE,
      },
      fileFilter: (req, file, cb) => {
        if (FILE_CONSTRAINTS.ALLOWED_TYPES.includes(file.mimetype)) {
          cb(null, true);
        } else {
          cb(new BadRequestException('Tipo de archivo no válido'), false);
        }
      },
    }),
  )
  async uploadPhoto(
    @UploadedFile() file: Express.Multer.File,
    @Body() uploadPhotoDto: UploadPhotoDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<ApiResponse> {
    const result = await this.uploadsService.uploadPhoto(
      file,
      uploadPhotoDto.eventId,
      req.user.id,
      req.user.role,
      {
        takenAt: uploadPhotoDto.takenAt,
      },
    );

    return { data: result };
  }

}
