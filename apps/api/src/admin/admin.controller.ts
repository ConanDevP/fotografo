import {
  Controller,
  Get,
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

import { AdminService } from './admin.service';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { ReprocessPhotoDto } from './dto/reprocess-photo.dto';
import { UserRole, ApiResponse } from '@shared/types';

interface AuthenticatedRequest extends Request {
  user: {
    id: string;
    email: string;
    role: UserRole;
  };
}

@Controller('admin')
@UseGuards(AuthGuard('jwt'), RolesGuard)
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Get('events/:eventId/metrics')
  @Roles(UserRole.PHOTOGRAPHER, UserRole.ADMIN)
  async getEventMetrics(
    @Param('eventId') eventId: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<ApiResponse> {
    const metrics = await this.adminService.getEventMetrics(eventId, req.user.role, req.user.id);
    return { data: metrics };
  }

  @Get('events/:eventId/top-bibs')
  @Roles(UserRole.PHOTOGRAPHER, UserRole.ADMIN)
  async getTopBibs(
    @Param('eventId') eventId: string,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Req() req: AuthenticatedRequest,
  ): Promise<ApiResponse> {
    const topBibs = await this.adminService.getTopBibs(eventId, req.user.role, req.user.id, limit);
    return { data: topBibs };
  }

  @Post('photos/:photoId/reprocess')
  @Roles(UserRole.ADMIN)
  async reprocessPhoto(
    @Param('photoId') photoId: string,
    @Body() reprocessDto: ReprocessPhotoDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<ApiResponse> {
    const result = await this.adminService.reprocessPhoto(
      photoId,
      reprocessDto.strategy,
      req.user.role,
    );
    return { data: result };
  }

  @Get('queue-stats')
  @Roles(UserRole.ADMIN)
  async getQueueStats(@Req() req: AuthenticatedRequest): Promise<ApiResponse> {
    const stats = await this.adminService.getQueueStats(req.user.role);
    return { data: stats };
  }

  @Get('system-stats')
  @Roles(UserRole.ADMIN)
  async getSystemStats(@Req() req: AuthenticatedRequest): Promise<ApiResponse> {
    const stats = await this.adminService.getSystemStats(req.user.role);
    return { data: stats };
  }

  @Get('audit-logs')
  @Roles(UserRole.ADMIN)
  async getAuditLogs(
    @Query('photoId') photoId: string | undefined,
    @Query('userId') userId: string | undefined,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
    @Req() req: AuthenticatedRequest,
  ): Promise<ApiResponse> {
    const result = await this.adminService.getAuditLogs(
      photoId,
      userId,
      page,
      limit,
      req.user.role,
    );
    return { 
      data: result.items,
      meta: { pagination: result.pagination },
    };
  }

  @Post('queue/clean')
  @Roles(UserRole.ADMIN)
  async cleanQueues(@Req() req: AuthenticatedRequest): Promise<ApiResponse> {
    // Only allow admins to clean queues
    if (req.user.role !== UserRole.ADMIN) {
      throw new Error('Forbidden');
    }
    
    // Clean completed/failed jobs older than 1 hour
    await this.adminService['queueService'].cleanQueues(60 * 60 * 1000);
    
    return { data: { message: 'Colas limpiadas exitosamente' } };
  }
}