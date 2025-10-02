import {
  Controller,
  Get,
  Patch,
  Delete,
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

import { AdminOrdersService } from './admin-orders.service';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto';
import { UserRole, ApiResponse } from '@shared/types';

interface AuthenticatedRequest extends Request {
  user: {
    id: string;
    email: string;
    role: UserRole;
  };
}

@Controller('admin/orders')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(UserRole.ADMIN)
export class AdminOrdersController {
  constructor(private readonly adminOrdersService: AdminOrdersService) {}

  @Get()
  async getAllOrders(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('status') status?: string,
    @Query('userId') userId?: string,
    @Query('eventId') eventId?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
    @Req() req?: AuthenticatedRequest,
  ): Promise<ApiResponse> {
    const filters: any = {};

    if (status) filters.status = status;
    if (userId) filters.userId = userId;
    if (eventId) filters.eventId = eventId;
    if (dateFrom) filters.dateFrom = dateFrom;
    if (dateTo) filters.dateTo = dateTo;

    const result = await this.adminOrdersService.getAllOrders(
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
  async getOrdersStats(@Req() req: AuthenticatedRequest): Promise<ApiResponse> {
    const stats = await this.adminOrdersService.getOrdersStats(req.user.role);
    return { data: stats };
  }

  @Get('revenue')
  async getRevenueReport(
    @Query('period') period: 'daily' | 'monthly' | 'yearly' = 'monthly',
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
    @Req() req?: AuthenticatedRequest,
  ): Promise<ApiResponse> {
    const report = await this.adminOrdersService.getRevenueReport(
      req.user.role,
      period,
      dateFrom,
      dateTo,
    );
    return { data: report };
  }

  @Get(':id')
  async getOrderById(
    @Param('id') id: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<ApiResponse> {
    const order = await this.adminOrdersService.getOrderById(id, req.user.role);
    return { data: order };
  }

  @Patch(':id/status')
  async updateOrderStatus(
    @Param('id') id: string,
    @Body() updateDto: UpdateOrderStatusDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<ApiResponse> {
    const order = await this.adminOrdersService.updateOrderStatus(
      id,
      updateDto.status,
      req.user.role,
    );
    return { data: order };
  }

  @Delete(':id')
  async deleteOrder(
    @Param('id') id: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<ApiResponse> {
    const result = await this.adminOrdersService.deleteOrder(id, req.user.role);
    return { data: result };
  }
}
