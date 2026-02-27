import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Query,
  UseGuards,
  Req,
  ParseIntPipe,
  DefaultValuePipe,
} from '@nestjs/common';


import { AuthGuard } from '@nestjs/passport';
import { Request } from 'express';

import { AdminBatchJobsService } from './admin-batch-jobs.service';
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

@Controller('admin/batch-jobs')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(UserRole.ADMIN)
export class AdminBatchJobsController {
  constructor(private readonly adminBatchJobsService: AdminBatchJobsService) {}

  @Get()
  async getAllBatchJobs(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('status') status?: string,
    @Query('ownerId') ownerId?: string,
    @Query('eventId') eventId?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
    @Req() req?: AuthenticatedRequest,
  ): Promise<ApiResponse> {
    const filters: any = {};

    if (status) filters.status = status;
    if (ownerId) filters.ownerId = ownerId;
    if (eventId) filters.eventId = eventId;
    if (dateFrom) filters.dateFrom = dateFrom;
    if (dateTo) filters.dateTo = dateTo;

    const result = await this.adminBatchJobsService.getAllBatchJobs(
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

  @Get('stats')
  async getBatchJobsStats(@Req() req: AuthenticatedRequest): Promise<ApiResponse> {
    const stats = await this.adminBatchJobsService.getBatchJobsStats(req.user.role);
    return { data: stats };
  }

  @Get(':id')
  async getBatchJobById(
    @Param('id') id: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<ApiResponse> {
    const job = await this.adminBatchJobsService.getBatchJobById(id, req.user.role);
    return { data: job };
  }

  @Post(':id/retry')
  async retryBatchJob(
    @Param('id') id: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<ApiResponse> {
    const job = await this.adminBatchJobsService.retryBatchJob(id, req.user.role);
    return { data: job };
  }

  @Post(':id/cancel')
  async cancelBatchJob(
    @Param('id') id: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<ApiResponse> {
    const job = await this.adminBatchJobsService.cancelBatchJob(id, req.user.role);
    return { data: job };
  }

  @Delete(':id')
  async deleteBatchJob(
    @Param('id') id: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<ApiResponse> {
    const result = await this.adminBatchJobsService.deleteBatchJob(id, req.user.role);
    return { data: result };
  }
}
