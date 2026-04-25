import {
  Controller,
  Get,
  Param,
  Query,
  DefaultValuePipe,
  ParseIntPipe,
  UseGuards,
  Req,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Request } from 'express';
import { PublicService } from './public.service';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { ApiResponse, UserRole } from '@shared/types';

interface AuthenticatedRequest extends Request {
  user: {
    id: string;
    email: string;
    role: UserRole;
  };
}

@Controller('public')
export class PublicController {
  constructor(private readonly publicService: PublicService) {}

  // ── Authenticated endpoints ───────────────────────────────────────────────

  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.ATHLETE, UserRole.PHOTOGRAPHER, UserRole.ADMIN)
  @Get('events/:eventId/photos')
  async getEventPhotosWithWatermark(
    @Param('eventId') eventId: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
    @Req() req: AuthenticatedRequest,
  ): Promise<ApiResponse> {
    const result = await this.publicService.getEventPhotosWithWatermark(
      eventId,
      page,
      Math.min(limit, 100),
    );
    return {
      data: result.items,
      meta: { pagination: result.pagination, total: result.total },
    };
  }

  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.ATHLETE, UserRole.PHOTOGRAPHER, UserRole.ADMIN)
  @Get('events/:eventId/photos/search')
  async searchPhotosByBibWithWatermark(
    @Param('eventId') eventId: string,
    @Query('bib') bib: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Req() req: AuthenticatedRequest,
  ): Promise<ApiResponse> {
    const result = await this.publicService.searchPhotosByBibWithWatermark(
      eventId,
      bib,
      page,
      Math.min(limit, 50),
    );
    return {
      data: result.items,
      meta: { pagination: result.pagination, total: result.total },
    };
  }

  // ── Public endpoints ──────────────────────────────────────────────────────

  @Get('events/:eventId')
  async getEventPublic(@Param('eventId') eventId: string): Promise<ApiResponse> {
    const event = await this.publicService.getEventPublic(eventId);
    return { data: event };
  }

  @Get('events')
  async getEventsPublic(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ): Promise<ApiResponse> {
    const result = await this.publicService.getEventsPublic(page, limit);
    return {
      data: result.items,
      meta: { pagination: result.pagination },
    };
  }

  // Returns N random processed photos from non-deleted events (landing page carousel)
  @Get('photos/random')
  async getRandomPhotos(
    @Query('limit', new DefaultValuePipe(24), ParseIntPipe) limit: number,
  ): Promise<ApiResponse> {
    const photos = await this.publicService.getRandomPhotos(Math.min(limit, 50));
    return { data: photos };
  }

  // Real platform stats for the landing page hero/counters
  @Get('stats')
  async getPublicStats(): Promise<ApiResponse> {
    const stats = await this.publicService.getPublicStats();
    return { data: stats };
  }
}
