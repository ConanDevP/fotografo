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
        confirmedBibs: (results as any).confirmedBibs ?? [],
        inferredBibs: (results as any).inferredBibs ?? [],
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
    const bibResults: any[] = [];
    const faceResults: any[] = [];
    let confirmedBibs: string[] = [];
    let inferredBibs: string[] = [];

    // Run bib search and face search in parallel when both are provided
    await Promise.all([
      body.bib
        ? this.searchService.searchPhotosByBib(eventId, body.bib, 50).then((r) => {
            bibResults.push(...r.items);
          })
        : Promise.resolve(),
      body.userImageBase64
        ? this.faceSearchService
            .searchPhotosByFace(eventId, {
              userImageBase64: body.userImageBase64,
              threshold: body.threshold,
            })
            .then((r) => {
              faceResults.push(...r.matches);
              confirmedBibs = (r as any).confirmedBibs ?? [];
              inferredBibs = (r as any).inferredBibs ?? [];
            })
        : Promise.resolve(),
    ]);

    // Merge and deduplicate — face portfolio results already include bib-only photos,
    // but bib search may add photos the face didn't find (e.g. low-confidence face far
    // from the camera). Priority: face-direct > bib > face-inferred.
    const priorityOf = (r: any): number => {
      if (r.discoveryType === 'FACE_DIRECT') return 4;
      if (r.source === 'bib' && r.type === 'DETECTED') return 3;
      if (r.discoveryType === 'BIB_VIA_FACE') return 3;
      if (r.source === 'bib' && r.type === 'INFERRED') return 2;
      if (r.discoveryType === 'INFERRED_VIA_FACE') return 1;
      return 2;
    };

    const allResults = [
      ...bibResults.map((r) => ({ ...r, source: 'bib' })),
      ...faceResults.map((r) => ({ ...r, source: 'face' })),
    ];

    const uniqueResults = new Map<string, any>();
    for (const result of allResults) {
      const existing = uniqueResults.get(result.photoId);
      if (!existing || priorityOf(result) > priorityOf(existing)) {
        uniqueResults.set(result.photoId, result);
      }
    }

    const combined = [...uniqueResults.values()].sort((a, b) => priorityOf(b) - priorityOf(a));

    return {
      data: {
        bibResults,
        faceResults,
        combined,
        confirmedBibs,
        inferredBibs,
      },
      meta: { total: combined.length },
    };
  }
}