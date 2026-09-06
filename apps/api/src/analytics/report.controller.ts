import { Controller, Get, Param, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiResponse } from '@shared/types';
import { PostEventReportService } from './post-event-report.service';

/**
 * Informe post-evento público de solo lectura. Sin sesión: la autoriza el token
 * HMAC del enlace. Pensado para que el organizador lo reenvíe a su equipo o a
 * sus patrocinadores.
 */
@Controller('public/reports')
export class ReportController {
  constructor(private readonly report: PostEventReportService) {}

  @Get('events/:eventId')
  @Throttle(60, 60)
  async publicReport(
    @Param('eventId') eventId: string,
    @Query('token') token: string | undefined,
  ): Promise<ApiResponse> {
    return { data: await this.report.publicReport(eventId, token ?? '') };
  }
}
