import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Query,
  Body,
  UseGuards,
  Req,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Request } from 'express';

import { PhotosService } from './photos.service';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { AddBibDto } from './dto/add-bib.dto';
import { UserRole, ApiResponse } from '@shared/types';

interface AuthenticatedRequest extends Request {
  user: {
    id: string;
    email: string;
    role: UserRole;
  };
}

@Controller('photos')
@UseGuards(AuthGuard('jwt'))
export class PhotosController {
  constructor(private readonly photosService: PhotosService) {}

  @Get(':id')
  async findOne(
    @Param('id') id: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<ApiResponse> {
    const photo = await this.photosService.findOne(id, req.user.id, req.user.role);
    return { data: photo };
  }

  @UseGuards(RolesGuard)
  @Roles(UserRole.PHOTOGRAPHER, UserRole.ADMIN)
  @Post(':id/process')
  async triggerProcessing(
    @Param('id') id: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<ApiResponse> {
    const result = await this.photosService.triggerProcessing(id, req.user.id, req.user.role);
    return { data: result };
  }

  @UseGuards(RolesGuard)
  @Roles(UserRole.PHOTOGRAPHER, UserRole.ADMIN)
  @Post(':id/bibs')
  async addBibCorrection(
    @Param('id') photoId: string,
    @Body() addBibDto: AddBibDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<ApiResponse> {
    const result = await this.photosService.addBibCorrection(
      photoId,
      addBibDto.bib,
      req.user.id,
      req.user.role,
      addBibDto.confidence,
      addBibDto.bbox,
    );
    return { data: result };
  }

  @UseGuards(RolesGuard)
  @Roles(UserRole.PHOTOGRAPHER, UserRole.ADMIN)
  @Delete(':id/bibs/:bibId')
  async removeBib(
    @Param('id') photoId: string,
    @Param('bibId') bibId: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<ApiResponse> {
    const result = await this.photosService.removeBib(photoId, bibId, req.user.id, req.user.role);
    return { data: result };
  }

  @UseGuards(RolesGuard)
  @Roles(UserRole.PHOTOGRAPHER, UserRole.ADMIN)
  @Delete(':id')
  async delete(
    @Param('id') id: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<ApiResponse> {
    const result = await this.photosService.delete(id, req.user.id, req.user.role);
    return { data: result };
  }

  @Get(':id/download')
  async generateDownloadUrl(
    @Param('id') id: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<ApiResponse> {
    const result = await this.photosService.generateSecureDownloadUrl(id, req.user.id, req.user.role);
    return { data: result };
  }
}