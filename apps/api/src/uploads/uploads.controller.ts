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
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(UserRole.PHOTOGRAPHER, UserRole.ADMIN)
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
    );
    return { data: { jobId: job.id } };
  }

  @Post('batch/append/:jobId')
  @UseInterceptors(
    FilesInterceptor('files', 100, { // Limite por chunk
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
  async appendToBatchUpload(
    @Param('jobId') jobId: string,
    @UploadedFiles() files: Express.Multer.File[],
    @Req() req: AuthenticatedRequest,
  ): Promise<ApiResponse> {
    if (!files || files.length === 0) {
      throw new BadRequestException('No se proporcionaron archivos en el chunk');
    }
    const result = await this.uploadsService.appendToBatchUpload(
      jobId,
      files,
      req.user.id,
      req.user.role,
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

  /*
  @Post('photos/batch')
  @Throttle(2, 60) // Reducir a 2 requests por minuto para batches grandes
  @UseInterceptors(
    FilesInterceptor('files', 5000, { // Aumentar límite a 5000 archivos
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
  async uploadPhotoBatch(
    @UploadedFiles() files: Express.Multer.File[],
    @Body() uploadPhotoDto: UploadPhotoDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<ApiResponse> {
    if (!files || files.length === 0) {
      throw new BadRequestException('No se proporcionaron archivos');
    }

    const result = await this.uploadsService.uploadPhotoBatch(
      files,
      uploadPhotoDto.eventId,
      req.user.id,
      req.user.role,
    );

    return { data: result };
  }
  */
}