import { Body, Controller, Get, Post, Query, Param, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { ApiResponse } from '@shared/types';
import { MetricsService } from './metrics.service';
import { RecordMetricDto } from './dto/record-metric.dto';

@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Post()
  @Throttle(120, 60)
  async record(@Body() dto: RecordMetricDto, @Req() req: Request): Promise<ApiResponse> {
    return { data: await this.metrics.record(dto, req) };
  }

  @UseGuards(AuthGuard('jwt'))
  @Get('workspaces/:workspaceId/overview')
  async overview(
    @Param('workspaceId') workspaceId: string,
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @Req() req: any,
  ): Promise<ApiResponse> {
    return { data: await this.metrics.overview(workspaceId, req.user.id, from, to) };
  }
}

