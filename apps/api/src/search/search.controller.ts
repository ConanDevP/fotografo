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
import { FaceSearchService } from './face-search.service';
import { SubscribeToBibDto } from './dto/subscribe-to-bib.dto';
import { SendPhotosDto } from './dto/send-photos.dto';
import { FaceSearchDto } from './dto/face-search.dto';
import { ApiResponse } from '@shared/types';
import { RATE_LIMITS, PAGINATION, FACE_SEARCH_LIMITS } from '@shared/constants';

@Controller('events/:eventId/search')
export class SearchController {
  constructor(
    private readonly searchService: SearchService,
    private readonly faceSearchService: FaceSearchService,
  ) {}

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

  // Face Recognition Endpoints
  
  @Post('photos/by-face')
  @Throttle(FACE_SEARCH_LIMITS.REGISTERED, 60)
  async searchByFace(
    @Param('eventId') eventId: string,
    @Body() faceSearchDto: FaceSearchDto,
  ): Promise<ApiResponse> {
    const results = await this.faceSearchService.searchPhotosByFace(eventId, {
      userImageBase64: faceSearchDto.userImageBase64,
      threshold: faceSearchDto.threshold,
    });
    
    return { 
      data: {
        matches: results.matches,
        userFaceDetected: results.userFaceDetected,
      },
      meta: { 
        total: results.total,
        searchTime: results.searchTime,
        optimized: true,
      },
    };
  }

  @Get('face-stats')
  async getFaceStats(
    @Param('eventId') eventId: string,
  ): Promise<ApiResponse> {
    const stats = await this.faceSearchService.getEventFaceStats(eventId);
    return { data: stats };
  }

  @Post('photos/hybrid')
  @Throttle(RATE_LIMITS.SEARCH, 60)
  async hybridSearch(
    @Param('eventId') eventId: string,
    @Body() body: { bib?: string; userImageBase64?: string; threshold?: number },
  ): Promise<ApiResponse> {
    const results = {
      bibResults: [] as any[],
      faceResults: [] as any[],
      combined: [] as any[],
    };

    // Search by bib if provided
    if (body.bib) {
      const bibSearch = await this.searchService.searchPhotosByBib(eventId, body.bib, 50);
      results.bibResults = bibSearch.items;
    }

    // Search by face if provided
    if (body.userImageBase64) {
      const faceSearch = await this.faceSearchService.searchPhotosByFace(eventId, {
        userImageBase64: body.userImageBase64,
        threshold: body.threshold,
      });
      results.faceResults = faceSearch.matches;
    }

    // Combine results and deduplicate
    const allResults = [
      ...results.bibResults.map(r => ({ ...r, source: 'bib' })),
      ...results.faceResults.map(r => ({ ...r, source: 'face' })),
    ];

    const uniqueResults = new Map();
    allResults.forEach(result => {
      const existing = uniqueResults.get(result.photoId);
      if (!existing || (result.confidence || result.similarity) > (existing.confidence || existing.similarity)) {
        uniqueResults.set(result.photoId, result);
      }
    });

    results.combined = Array.from(uniqueResults.values());

    return { 
      data: results,
      meta: { 
        total: results.combined.length,
      },
    };
  }
}