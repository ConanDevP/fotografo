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
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AuthGuard } from '@nestjs/passport';
import { Request } from 'express';
import { Throttle } from '@nestjs/throttler';

import { EventsService } from './events.service';
import { CreateEventDto } from './dto/create-event.dto';
import { UpdateEventDto } from './dto/update-event.dto';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { UserRole, ApiResponse } from '@shared/types';

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

  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.PHOTOGRAPHER, UserRole.ADMIN)
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

  @Get(':id')
  async findOne(@Param('id') id: string): Promise<ApiResponse> {
    const event = await this.eventsService.findOne(id);
    return { data: event };
  }

  @Get('slug/:slug')
  async findBySlug(@Param('slug') slug: string): Promise<ApiResponse> {
    const event = await this.eventsService.findBySlug(slug);
    return { data: event };
  }

  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.PHOTOGRAPHER, UserRole.ADMIN)
  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() updateEventDto: UpdateEventDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<ApiResponse> {
    const event = await this.eventsService.update(id, updateEventDto, req.user.id, req.user.role);
    return { data: event };
  }

  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.PHOTOGRAPHER, UserRole.ADMIN)
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

  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.PHOTOGRAPHER, UserRole.ADMIN)
  @Get(':id/photos')
  async getEventPhotos(
    @Param('id') eventId: string,
    @Req() req: AuthenticatedRequest,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('status') status?: string,
  ): Promise<ApiResponse> {
    const pageNum = page ? parseInt(page) : 1;
    const limitNum = limit ? parseInt(limit) : 50;
    
    const result = await this.eventsService.getEventPhotos(
      eventId, 
      req.user.id, 
      req.user.role,
      pageNum,
      limitNum,
      status as any
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

  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.PHOTOGRAPHER, UserRole.ADMIN)
  @UseInterceptors(FileInterceptor('image'))
  @Post(':id/image')
  async uploadEventImage(
    @Param('id') eventId: string,
    @UploadedFile() file: Express.Multer.File,
    @Req() req: AuthenticatedRequest,
  ): Promise<ApiResponse> {
    const event = await this.eventsService.uploadEventImage(eventId, file, req.user.id, req.user.role);
    return { data: event };
  }

  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.PHOTOGRAPHER, UserRole.ADMIN)
  @Delete(':id/image')
  async removeEventImage(
    @Param('id') eventId: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<ApiResponse> {
    const event = await this.eventsService.removeEventImage(eventId, req.user.id, req.user.role);
    return { data: event };
  }

  @Throttle(5, 60)
  @Post(':id/subscribe')
  async subscribe(
    @Param('id') eventId: string,
    @Body() body: { bib: string; email: string },
  ): Promise<ApiResponse> {
    // TODO: Implement subscription logic
    return { data: { message: 'Suscripción creada' } };
  }
}