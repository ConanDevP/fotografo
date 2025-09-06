import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  Body,
  ParseIntPipe,
  DefaultValuePipe,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import { SearchService } from './search.service';
import { SubscribeToBibDto } from './dto/subscribe-to-bib.dto';
import { SendPhotosDto } from './dto/send-photos.dto';
import { ApiResponse } from '@shared/types';
import { RATE_LIMITS, PAGINATION } from '@shared/constants';

@Controller('events/:eventId/search')
export class SearchController {
  constructor(private readonly searchService: SearchService) {}

  @Get('photos')
  @Throttle(RATE_LIMITS.SEARCH, 60)
  async searchByBib(
    @Param('eventId') eventId: string,
    @Query('bib') bib: string,
    @Query('limit', new DefaultValuePipe(PAGINATION.DEFAULT_LIMIT), ParseIntPipe) limit: number,
    @Query('cursor') cursor?: string,
  ): Promise<ApiResponse> {
    // Always use database search for reliability
    const results = await this.searchService.searchPhotosByBib(eventId, bib, limit, cursor);
    return { 
      data: results.items,
      meta: { 
        cursor: results.nextCursor,
        total: results.total,
      },
    };
  }

  @Get('photos/original')
  @Throttle(RATE_LIMITS.SEARCH, 60)
  async searchOriginalsByBib(
    @Param('eventId') eventId: string,
    @Query('bib') bib: string,
    @Query('limit', new DefaultValuePipe(PAGINATION.DEFAULT_LIMIT), ParseIntPipe) limit: number,
    @Query('cursor') cursor?: string,
  ): Promise<ApiResponse> {
    const results = await this.searchService.searchOriginalPhotosByBib(eventId, bib, limit, cursor);
    return { 
      data: results.items,
      meta: { 
        cursor: results.nextCursor,
        total: results.total,
      },
    };
  }

  @Get('photos/watermark')
  @Throttle(RATE_LIMITS.SEARCH, 60)
  async searchWatermarksByBib(
    @Param('eventId') eventId: string,
    @Query('bib') bib: string,
    @Query('limit', new DefaultValuePipe(PAGINATION.DEFAULT_LIMIT), ParseIntPipe) limit: number,
    @Query('cursor') cursor?: string,
  ): Promise<ApiResponse> {
    const results = await this.searchService.searchWatermarkPhotosByBib(eventId, bib, limit, cursor);
    return { 
      data: results.items,
      meta: { 
        cursor: results.nextCursor,
        total: results.total,
      },
    };
  }

  @Get('photos/thumb')
  @Throttle(RATE_LIMITS.SEARCH, 60)
  async searchThumbsByBib(
    @Param('eventId') eventId: string,
    @Query('bib') bib: string,
    @Query('limit', new DefaultValuePipe(PAGINATION.DEFAULT_LIMIT), ParseIntPipe) limit: number,
    @Query('cursor') cursor?: string,
  ): Promise<ApiResponse> {
    const results = await this.searchService.searchThumbPhotosByBib(eventId, bib, limit, cursor);
    return { 
      data: results.items,
      meta: { 
        cursor: results.nextCursor,
        total: results.total,
      },
    };
  }

  @Get('all-photos/watermark')
  @Throttle(RATE_LIMITS.SEARCH, 60)
  async getAllWatermarkPhotos(
    @Param('eventId') eventId: string,
    @Query('limit', new DefaultValuePipe(PAGINATION.DEFAULT_LIMIT), ParseIntPipe) limit: number,
    @Query('cursor') cursor?: string,
  ): Promise<ApiResponse> {
    const results = await this.searchService.getAllWatermarkPhotos(eventId, limit, cursor);
    return { 
      data: results.items,
      meta: { 
        cursor: results.nextCursor,
        total: results.total,
      },
    };
  }

  @Post('subscribe')
  @Throttle(RATE_LIMITS.EMAIL, 60)
  async subscribe(
    @Param('eventId') eventId: string,
    @Body() subscribeDto: SubscribeToBibDto,
  ): Promise<ApiResponse> {
    const result = await this.searchService.subscribeToNotifications(
      eventId,
      subscribeDto.bib,
      subscribeDto.email,
    );
    return { data: result };
  }

  @Post('email-photos')
  @Throttle(RATE_LIMITS.EMAIL, 60)
  async sendPhotosToEmail(
    @Param('eventId') eventId: string,
    @Body() sendPhotosDto: SendPhotosDto,
  ): Promise<ApiResponse> {
    const result = await this.searchService.sendPhotosToEmail(
      eventId,
      sendPhotosDto.bib,
      sendPhotosDto.email,
      sendPhotosDto.selectedPhotos,
    );
    return { data: result };
  }

  @Get('popular-bibs')
  async getPopularBibs(
    @Param('eventId') eventId: string,
    @Query('limit', new DefaultValuePipe(10), ParseIntPipe) limit: number,
  ): Promise<ApiResponse> {
    const results = await this.searchService.getPopularBibs(eventId, limit);
    return { data: results };
  }
}