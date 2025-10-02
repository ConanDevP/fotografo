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

import { AdminEventsService } from './admin-events.service';
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

@Controller('admin/events')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(UserRole.ADMIN)
export class AdminEventsController {
  constructor(private readonly adminEventsService: AdminEventsService) {}

  @Get()
  async getAllEvents(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('ownerId') ownerId?: string,
    @Query('includeDeleted') includeDeleted?: string,
    @Query('search') search?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
    @Req() req?: AuthenticatedRequest,
  ): Promise<ApiResponse> {
    const filters: any = {};

    if (ownerId) filters.ownerId = ownerId;
    if (includeDeleted !== undefined) filters.includeDeleted = includeDeleted === 'true';
    if (search) filters.search = search;
    if (dateFrom) filters.dateFrom = dateFrom;
    if (dateTo) filters.dateTo = dateTo;

    const result = await this.adminEventsService.getAllEvents(
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

  @Get('deleted')
  async getDeletedEvents(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Req() req: AuthenticatedRequest,
  ): Promise<ApiResponse> {
    const result = await this.adminEventsService.getDeletedEvents(req.user.role, page, limit);
    return {
      data: result.items,
      meta: { pagination: result.pagination },
    };
  }

  @Get('stats')
  async getEventsStats(@Req() req: AuthenticatedRequest): Promise<ApiResponse> {
    const stats = await this.adminEventsService.getEventsStats(req.user.role);
    return { data: stats };
  }

  @Get(':id')
  async getEventById(
    @Param('id') id: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<ApiResponse> {
    const event = await this.adminEventsService.getEventById(id, req.user.role);
    return { data: event };
  }

  @Patch(':id')
  async updateEvent(
    @Param('id') id: string,
    @Body() updateData: any,
    @Req() req: AuthenticatedRequest,
  ): Promise<ApiResponse> {
    const event = await this.adminEventsService.updateEvent(id, updateData, req.user.role);
    return { data: event };
  }

  @Delete(':id/permanent')
  async deleteEventPermanently(
    @Param('id') id: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<ApiResponse> {
    const result = await this.adminEventsService.deleteEventPermanently(id, req.user.role);
    return { data: result };
  }

  @Patch(':id/restore')
  async restoreEvent(
    @Param('id') id: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<ApiResponse> {
    const event = await this.adminEventsService.restoreEvent(id, req.user.role);
    return { data: event };
  }

  @Post(':id/reassign')
  async reassignOwner(
    @Param('id') id: string,
    @Body('newOwnerId') newOwnerId: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<ApiResponse> {
    const event = await this.adminEventsService.reassignEventOwner(id, newOwnerId, req.user.role);
    return { data: event };
  }
}
