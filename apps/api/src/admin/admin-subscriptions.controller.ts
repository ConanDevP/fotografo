import {
  Controller,
  Get,
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

import { AdminSubscriptionsService } from './admin-subscriptions.service';
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

@Controller('admin/subscriptions')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(UserRole.ADMIN)
export class AdminSubscriptionsController {
  constructor(private readonly adminSubscriptionsService: AdminSubscriptionsService) {}

  @Get()
  async getAllSubscriptions(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
    @Query('eventId') eventId?: string,
    @Query('email') email?: string,
    @Query('bib') bib?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
    @Req() req?: AuthenticatedRequest,
  ): Promise<ApiResponse> {
    const filters: any = {};

    if (eventId) filters.eventId = eventId;
    if (email) filters.email = email;
    if (bib) filters.bib = bib;
    if (dateFrom) filters.dateFrom = dateFrom;
    if (dateTo) filters.dateTo = dateTo;

    const result = await this.adminSubscriptionsService.getAllSubscriptions(
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
  async getSubscriptionsStats(@Req() req: AuthenticatedRequest): Promise<ApiResponse> {
    const stats = await this.adminSubscriptionsService.getSubscriptionsStats(req.user.role);
    return { data: stats };
  }

  @Get('event/:eventId')
  async getSubscriptionsByEvent(
    @Param('eventId') eventId: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
    @Req() req: AuthenticatedRequest,
  ): Promise<ApiResponse> {
    const result = await this.adminSubscriptionsService.getSubscriptionsByEvent(
      eventId,
      req.user.role,
      page,
      limit,
    );
    return {
      data: result.items,
      meta: { pagination: result.pagination },
    };
  }

  @Get(':id')
  async getSubscriptionById(
    @Param('id') id: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<ApiResponse> {
    const subscription = await this.adminSubscriptionsService.getSubscriptionById(
      id,
      req.user.role,
    );
    return { data: subscription };
  }

  @Delete(':id')
  async deleteSubscription(
    @Param('id') id: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<ApiResponse> {
    const result = await this.adminSubscriptionsService.deleteSubscription(id, req.user.role);
    return { data: result };
  }

  @Post('bulk-delete')
  async bulkDeleteSubscriptions(
    @Body('subscriptionIds') subscriptionIds: string[],
    @Req() req: AuthenticatedRequest,
  ): Promise<ApiResponse> {
    const result = await this.adminSubscriptionsService.bulkDeleteSubscriptions(
      subscriptionIds,
      req.user.role,
    );
    return { data: result };
  }
}
