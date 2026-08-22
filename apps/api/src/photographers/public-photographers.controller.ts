import {
  Controller,
  Get,
  Param,
  Query,
  DefaultValuePipe,
  ParseIntPipe
} from '@nestjs/common';

import { PublicPhotographersService } from './public-photographers.service';
import { PhotographerQueryDto } from './dto/photographer-query.dto';
import { ApiResponse } from '@shared/types';

@Controller('public/photographers')
export class PublicPhotographersController {
  constructor(private readonly publicPhotographersService: PublicPhotographersService) {}

  @Get()
  async findPhotographers(
    @Query() query: PhotographerQueryDto,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number
  ): Promise<ApiResponse> {
    const result = await this.publicPhotographersService.findPhotographers(
      query,
      page,
      Math.min(limit, 50) // Máximo 50 por página
    );

    return {
      data: result.items,
      meta: {
        pagination: result.pagination
      }
    };
  }

  @Get(':slug')
  async getPhotographerBySlug(@Param('slug') slug: string): Promise<ApiResponse> {
    const photographer = await this.publicPhotographersService.getPhotographerBySlug(slug);
    return { data: photographer };
  }

  @Get(':slug/events')
  async getPhotographerEvents(
    @Param('slug') slug: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number
  ): Promise<any> {
    const result = await this.publicPhotographersService.getPhotographerEvents(
      slug,
      page,
      Math.min(limit, 50) // Máximo 50 por página
    );

    return {
      data: result.items,
      meta: {
        pagination: result.pagination,
        photographer: result.photographer
      }
    };
  }
}
