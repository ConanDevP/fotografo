import { Controller, Post, Get, Param, Body, Req, Res, UseGuards, Logger } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Request, Response } from 'express';
import { FreeDownloadsService } from './free-downloads.service';

interface FreeDownloadDto {
  email?: string;
  name?: string;
  phone?: string;
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
  async getAnalytics(@Param('eventId') eventId: string) {
    const analytics = await this.freeDownloadsService.getEventAnalytics(eventId);

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
    @Res() res: Response,
  ) {
    const csv = await this.freeDownloadsService.exportEmails(eventId);

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="emails-evento-${eventId}.csv"`);
    res.send(csv);
  }
}
