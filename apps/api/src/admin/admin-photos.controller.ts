import {
  Controller,
  Get,
  Patch,
  Delete,
  Post,
  Param,
  Query,
  Body,
  UseGuards,
  Req,
  ParseIntPipe,
  DefaultValuePipe,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Request } from 'express';

import { AdminPhotosService } from './admin-photos.service';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { UserRole, ApiResponse } from '@shared/types';

interface AuthenticatedRequest extends Request {
  user: {
    id: string;
    email: string;
    role: UserRole;
  };
}

@Controller('admin/photos')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(UserRole.ADMIN)
export class AdminPhotosController {
  constructor(private readonly adminPhotosService: AdminPhotosService) {}

  @Get()
  async getAllPhotos(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
    @Query('status') status?: string,
    @Query('eventId') eventId?: string,
    @Query('photographerId') photographerId?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
    @Req() req?: AuthenticatedRequest,
  ): Promise<ApiResponse> {
    const filters: any = {};

    if (status) filters.status = status;
    if (eventId) filters.eventId = eventId;
    if (photographerId) filters.photographerId = photographerId;
    if (dateFrom) filters.dateFrom = dateFrom;
    if (dateTo) filters.dateTo = dateTo;

    const result = await this.adminPhotosService.getAllPhotos(
      req.user.role,
      page,
      limit,
      filters,
    );

    return {
      data: result.items,
      meta: { pagination: result.pagination },
    };
  }

  @Get('failed')
  async getFailedPhotos(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
    @Req() req: AuthenticatedRequest,
  ): Promise<ApiResponse> {
    const result = await this.adminPhotosService.getFailedPhotos(req.user.role, page, limit);
    return {
      data: result.items,
      meta: { pagination: result.pagination },
    };
  }

  @Get('stats')
  async getPhotosStats(@Req() req: AuthenticatedRequest): Promise<ApiResponse> {
    const stats = await this.adminPhotosService.getPhotosStats(req.user.role);
    return { data: stats };
  }

  @Get(':id')
  async getPhotoById(
    @Param('id') id: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<ApiResponse> {
    const photo = await this.adminPhotosService.getPhotoById(id, req.user.role);
    return { data: photo };
  }

  @Patch(':id')
  async updatePhoto(
    @Param('id') id: string,
    @Body() updateData: any,
    @Req() req: AuthenticatedRequest,
  ): Promise<ApiResponse> {
    const photo = await this.adminPhotosService.updatePhoto(id, updateData, req.user.role);
    return { data: photo };
  }

  @Post(':id/reassign')
  async reassignPhoto(
    @Param('id') id: string,
    @Body('eventId') eventId?: string,
    @Body('photographerId') photographerId?: string,
    @Req() req?: AuthenticatedRequest,
  ): Promise<ApiResponse> {
    const photo = await this.adminPhotosService.reassignPhoto(
      id,
      eventId,
      photographerId,
      req.user.role,
    );
    return { data: photo };
  }

  @Delete(':id/permanent')
  async deletePhotoPermanently(
    @Param('id') id: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<ApiResponse> {
    const result = await this.adminPhotosService.deletePhotoPermanently(id, req.user.role);
    return { data: result };
  }

  @Post('bulk-delete')
  async bulkDeletePhotos(
    @Body('photoIds') photoIds: string[],
    @Req() req: AuthenticatedRequest,
  ): Promise<ApiResponse> {
    const result = await this.adminPhotosService.bulkDeletePhotos(photoIds, req.user.role);
    return { data: result };
  }
}
