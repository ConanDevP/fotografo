import { Controller, Post, Get, Param, Body, Req, Res, UseGuards, Logger } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Request, Response } from 'express';
import { FreeDownloadsService } from './free-downloads.service';
import { Throttle } from '@nestjs/throttler';
import { IsEmail, IsOptional, IsString, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';

class FreeDownloadDto {
  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  @Transform(({ value }) => typeof value === 'string' ? value.trim().toLowerCase() : value)
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  bibNumber?: string;
}

@Controller('events')
export class FreeDownloadsController {
  private readonly logger = new Logger(FreeDownloadsController.name);

  constructor(private freeDownloadsService: FreeDownloadsService) {}

  /**
   * Public endpoint - Download photo for free
   * POST /events/:eventId/photos/:photoId/download-free
   */
  @Post(':eventId/photos/:photoId/download-free')
  @Throttle(10, 60)
  async downloadFreePhoto(
    @Param('eventId') eventId: string,
    @Param('photoId') photoId: string,
    @Body() userData: FreeDownloadDto,
    @Req() req: Request,
  ) {
    const result = await this.freeDownloadsService.downloadFreePhoto(
      eventId,
      photoId,
      userData,
      req,
    );

    return {
      data: result,
    };
  }

  /**
   * Get analytics for event's free downloads (admin/photographer only)
   * GET /events/:eventId/free-downloads/analytics
   */
  @UseGuards(AuthGuard('jwt'))
  @Get(':eventId/free-downloads/analytics')
  async getAnalytics(@Param('eventId') eventId: string, @Req() req: any) {
    const analytics = await this.freeDownloadsService.getEventAnalytics(eventId, req.user.id, req.user.role);

    return {
      data: analytics,
    };
  }

  /**
   * Export emails from free downloads (admin/photographer only)
   * GET /events/:eventId/free-downloads/export-emails
   */
  @UseGuards(AuthGuard('jwt'))
  @Get(':eventId/free-downloads/export-emails')
  async exportEmails(
    @Param('eventId') eventId: string,
    @Req() req: any,
    @Res() res: Response,
  ) {
    const csv = await this.freeDownloadsService.exportEmails(eventId, req.user.id, req.user.role);

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="emails-evento-${eventId}.csv"`);
    res.send(csv);
  }
}
