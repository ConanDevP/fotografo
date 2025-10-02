import {
  Controller,
  Get,
  Post,
  Query,
  UseGuards,
  Req,
  ParseIntPipe,
  DefaultValuePipe,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Request } from 'express';

import { AdminSystemService } from './admin-system.service';
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

@Controller('admin/system')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(UserRole.ADMIN)
export class AdminSystemController {
  constructor(private readonly adminSystemService: AdminSystemService) {}

  @Get('health')
  async getHealthCheck(@Req() req: AuthenticatedRequest): Promise<ApiResponse> {
    const health = await this.adminSystemService.getHealthCheck(req.user.role);
    return { data: health };
  }

  @Get('reports/daily')
  async getDailyReport(
    @Query('date') date?: string,
    @Req() req?: AuthenticatedRequest,
  ): Promise<ApiResponse> {
    const report = await this.adminSystemService.getDailyReport(req.user.role, date);
    return { data: report };
  }

  @Get('reports/monthly')
  async getMonthlyReport(
    @Query('year', new DefaultValuePipe(new Date().getFullYear()), ParseIntPipe) year: number,
    @Query('month', new DefaultValuePipe(new Date().getMonth() + 1), ParseIntPipe) month: number,
    @Req() req?: AuthenticatedRequest,
  ): Promise<ApiResponse> {
    const report = await this.adminSystemService.getMonthlyReport(req.user.role, year, month);
    return { data: report };
  }

  @Get('reports/users-growth')
  async getUsersGrowthReport(
    @Query('months', new DefaultValuePipe(12), ParseIntPipe) months: number,
    @Req() req: AuthenticatedRequest,
  ): Promise<ApiResponse> {
    const report = await this.adminSystemService.getUsersGrowthReport(req.user.role, months);
    return { data: report };
  }

  @Get('reports/events-performance')
  async getEventsPerformanceReport(
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Req() req: AuthenticatedRequest,
  ): Promise<ApiResponse> {
    const report = await this.adminSystemService.getEventsPerformanceReport(req.user.role, limit);
    return { data: report };
  }

  @Post('cleanup/audit-logs')
  async cleanupOldAuditLogs(
    @Query('daysToKeep', new DefaultValuePipe(90), ParseIntPipe) daysToKeep: number,
    @Req() req: AuthenticatedRequest,
  ): Promise<ApiResponse> {
    const result = await this.adminSystemService.cleanupOldAuditLogs(req.user.role, daysToKeep);
    return { data: result };
  }
}
