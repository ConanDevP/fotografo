import { 
  Controller, 
  Get, 
  Post, 
  Body, 
  Patch, 
  Param, 
  Delete, 
  UseGuards,
  Query,
  Req,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
  Headers,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AuthGuard } from '@nestjs/passport';
import { Request } from 'express';

import { EventsService } from './events.service';
import { CreateEventDto } from './dto/create-event.dto';
import { UpdateEventDto } from './dto/update-event.dto';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { UserRole, ApiResponse } from '@shared/types';
import { InviteContributorDto } from './dto/invite-contributor.dto';
import { ReviewPhotoDto } from './dto/review-photo.dto';
import { Throttle } from '@nestjs/throttler';

interface AuthenticatedRequest extends Request {
  user: {
    id: string;
    email: string;
    role: UserRole;
  };
}

@Controller('events')
export class EventsController {
  constructor(private readonly eventsService: EventsService) {}

  @UseGuards(AuthGuard('jwt'))
  @Post()
  async create(
    @Body() createEventDto: CreateEventDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<ApiResponse> {
    const event = await this.eventsService.create(createEventDto, req.user.id);
    return { data: event };
  }

  @Get()
  async findAll(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ): Promise<ApiResponse> {
    const pageNum = page ? parseInt(page) : 1;
    const limitNum = limit ? parseInt(limit) : 20;
    
    const result = await this.eventsService.findAll(pageNum, limitNum);
    return { 
      data: result.items,
      meta: { pagination: result.pagination },
    };
  }

  @UseGuards(AuthGuard('jwt'))
  @Get('my-events')
  async getMyEvents(
    @Req() req: AuthenticatedRequest,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ): Promise<ApiResponse> {
    const pageNum = page ? parseInt(page) : 1;
    const limitNum = limit ? parseInt(limit) : 20;
    
    const result = await this.eventsService.getPhotographerEvents(req.user.id, req.user.role, pageNum, limitNum);
    return { 
      data: result.items,
      meta: { pagination: result.pagination },
    };
  }

  @UseGuards(AuthGuard('jwt'))
  @Get(':id')
  async findOne(
    @Param('id') id: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<ApiResponse> {
    const event = await this.eventsService.findOneForUser(id, req.user.id, req.user.role);
    return { data: event };
  }

  @Get('slug/:slug')
  async findBySlug(@Param('slug') slug: string): Promise<ApiResponse> {
    const event = await this.eventsService.findBySlug(slug);
    return { data: event };
  }

  @UseGuards(AuthGuard('jwt'))
  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() updateEventDto: UpdateEventDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<ApiResponse> {
    const event = await this.eventsService.update(id, updateEventDto, req.user.id, req.user.role);
    return { data: event };
  }

  @UseGuards(AuthGuard('jwt'))
  @Delete(':id')
  async remove(
    @Param('id') id: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<ApiResponse> {
    await this.eventsService.remove(id, req.user.id, req.user.role);
    return { data: { message: 'Evento ocultado correctamente' } };
  }

  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.ADMIN)
  @Patch(':id/restore')
  async restore(
    @Param('id') id: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<ApiResponse> {
    const event = await this.eventsService.restore(id, req.user.id, req.user.role);
    return { data: event };
  }

  @UseGuards(AuthGuard('jwt'))
  @Get(':id/photos')
  async getEventPhotos(
    @Param('id') eventId: string,
    @Req() req: AuthenticatedRequest,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('status') status?: string,
    @Query('publicationStatus') publicationStatus?: string,
  ): Promise<ApiResponse> {
    const pageNum = page ? parseInt(page) : 1;
    const limitNum = limit ? parseInt(limit) : 50;
    
    const result = await this.eventsService.getEventPhotos(
      eventId, 
      req.user.id, 
      req.user.role,
      pageNum,
      limitNum,
      status as any,
      publicationStatus as any,
    );
    
    return { 
      data: result.items,
      meta: { 
        pagination: result.pagination,
        total: result.stats.total,
        ...result.stats
      },
    };
  }

  @UseGuards(AuthGuard('jwt'))
  @UseInterceptors(FileInterceptor('image', {
    limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 5 },
    fileFilter: (_req, file, callback) => {
      if (['image/jpeg', 'image/jpg', 'image/png'].includes(file.mimetype)) callback(null, true);
      else callback(new BadRequestException('Solo se permiten archivos JPG y PNG'), false);
    },
  }))
  @Post(':id/image')
  async uploadEventImage(
    @Param('id') eventId: string,
    @UploadedFile() file: Express.Multer.File,
    @Req() req: AuthenticatedRequest,
  ): Promise<ApiResponse> {
    const event = await this.eventsService.uploadEventImage(eventId, file, req.user.id, req.user.role);
    return { data: event };
  }

  @UseGuards(AuthGuard('jwt'))
  @Delete(':id/image')
  async removeEventImage(
    @Param('id') eventId: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<ApiResponse> {
    const event = await this.eventsService.removeEventImage(eventId, req.user.id, req.user.role);
    return { data: event };
  }

  @UseGuards(AuthGuard('jwt'))
  @Get(':id/bibs/low-confidence')
  async getLowConfidenceBibs(
    @Param('id') eventId: string,
    @Req() req: AuthenticatedRequest,
    @Query('threshold') threshold?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ): Promise<ApiResponse> {
    const thresholdNum = threshold ? parseFloat(threshold) : 0.8;
    const pageNum = page ? parseInt(page) : 1;
    const limitNum = limit ? parseInt(limit) : 50;
    
    const result = await this.eventsService.getLowConfidenceBibs(
      eventId, 
      req.user.id, 
      req.user.role,
      thresholdNum,
      pageNum,
      limitNum
    );
    
    return { 
      data: result.items,
      meta: { 
        pagination: result.pagination,
        total: result.pagination.total,
      },
    };
  }

  @UseGuards(AuthGuard('jwt'))
  @Post(':id/contributors/invite')
  async inviteContributor(
    @Param('id') eventId: string,
    @Body() dto: InviteContributorDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<ApiResponse> {
    return { data: await this.eventsService.inviteContributor(eventId, dto, req.user.id, req.user.role) };
  }

  @UseGuards(AuthGuard('jwt'))
  @Get(':id/contributors')
  async listContributors(
    @Param('id') eventId: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<ApiResponse> {
    return { data: await this.eventsService.listContributors(eventId, req.user.id, req.user.role) };
  }

  @UseGuards(AuthGuard('jwt'))
  @Delete(':id/contributors/:contributorId')
  async revokeContributor(
    @Param('id') eventId: string,
    @Param('contributorId') contributorId: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<ApiResponse> {
    return { data: await this.eventsService.revokeContributor(eventId, contributorId, req.user.id, req.user.role) };
  }

  @UseGuards(AuthGuard('jwt'))
  @Patch(':id/photos/:photoId/review')
  async reviewPhoto(
    @Param('id') eventId: string,
    @Param('photoId') photoId: string,
    @Body() dto: ReviewPhotoDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<ApiResponse> {
    return { data: await this.eventsService.reviewPhoto(eventId, photoId, dto, req.user.id, req.user.role) };
  }

  @Get('invitations/current')
  @Throttle(30, 60)
  async getCurrentInvitation(
    @Headers('x-invitation-token') token: string | undefined,
  ): Promise<ApiResponse> {
    return { data: await this.eventsService.getInvitation(token || '') };
  }

  @UseGuards(AuthGuard('jwt'))
  @Post('invitations/current/accept')
  @Throttle(10, 60)
  async acceptCurrentInvitation(
    @Headers('x-invitation-token') token: string | undefined,
    @Req() req: AuthenticatedRequest,
  ): Promise<ApiResponse> {
    return { data: await this.eventsService.acceptInvitation(token || '', req.user.id) };
  }

  // Backward compatibility for invitations issued before private-header links.
  @Get('invitations/:token')
  @Throttle(30, 60)
  async getInvitation(@Param('token') token: string): Promise<ApiResponse> {
    return { data: await this.eventsService.getInvitation(token) };
  }

  @UseGuards(AuthGuard('jwt'))
  @Post('invitations/:token/accept')
  @Throttle(10, 60)
  async acceptInvitation(
    @Param('token') token: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<ApiResponse> {
    return { data: await this.eventsService.acceptInvitation(token, req.user.id) };
  }
}
