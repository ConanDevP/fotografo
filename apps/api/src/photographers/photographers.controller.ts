import {
  Controller,
  Get,
  Put,
  Body,
  UseGuards,
  Req,
  HttpCode,
  HttpStatus,
  BadRequestException,
  Query
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Request } from 'express';

import { PhotographersService } from './photographers.service';
import { UpdatePhotographerProfileDto } from './dto/update-photographer-profile.dto';
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

@Controller('photographers')
@UseGuards(AuthGuard('jwt'), RolesGuard)
export class PhotographersController {
  constructor(private readonly photographersService: PhotographersService) {}

  @Get('profile')
  @Roles(UserRole.PHOTOGRAPHER)
  async getMyProfile(@Req() req: AuthenticatedRequest): Promise<ApiResponse> {
    const profile = await this.photographersService.getPhotographerProfile(req.user.id);
    return { data: profile };
  }

  @Put('profile')
  @Roles(UserRole.PHOTOGRAPHER)
  @HttpCode(HttpStatus.OK)
  async updateProfile(
    @Req() req: AuthenticatedRequest,
    @Body() updateProfileDto: UpdatePhotographerProfileDto
  ): Promise<ApiResponse> {
    const updatedProfile = await this.photographersService.updatePhotographerProfile(
      req.user.id,
      updateProfileDto
    );
    return { data: updatedProfile };
  }

  @Get('dashboard/stats')
  @Roles(UserRole.PHOTOGRAPHER)
  async getDashboardStats(@Req() req: AuthenticatedRequest): Promise<ApiResponse> {
    const stats = await this.photographersService.getPhotographerStats(req.user.id);
    return { data: stats };
  }

  @Get('validate-slug')
  @Roles(UserRole.PHOTOGRAPHER)
  async validateSlug(
    @Query('slug') slug: string,
    @Req() req: AuthenticatedRequest
  ): Promise<ApiResponse> {
    if (!slug) {
      throw new BadRequestException('Slug es requerido');
    }

    const isAvailable = await this.photographersService.validateSlug(slug, req.user.id);
    
    return {
      data: {
        slug,
        available: isAvailable,
        message: isAvailable ? 'Slug disponible' : 'Slug ya está en uso'
      }
    };
  }
}