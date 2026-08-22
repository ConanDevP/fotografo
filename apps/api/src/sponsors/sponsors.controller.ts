import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiResponse } from '@shared/types';
import { CreateSponsorDto } from './dto/create-sponsor.dto';
import { AttachEventSponsorDto } from './dto/attach-event-sponsor.dto';
import { SponsorsService } from './sponsors.service';
import { UpdateSponsorDto } from './dto/update-sponsor.dto';

@Controller()
@UseGuards(AuthGuard('jwt'))
export class SponsorsController {
  constructor(private readonly sponsors: SponsorsService) {}

  @Post('workspaces/:workspaceId/sponsors')
  async create(@Param('workspaceId') workspaceId: string, @Body() dto: CreateSponsorDto, @Req() req: any): Promise<ApiResponse> {
    return { data: await this.sponsors.create(workspaceId, dto, req.user.id) };
  }

  @Get('workspaces/:workspaceId/sponsors')
  async list(@Param('workspaceId') workspaceId: string, @Req() req: any): Promise<ApiResponse> {
    return { data: await this.sponsors.list(workspaceId, req.user.id) };
  }

  @Patch('workspaces/:workspaceId/sponsors/:sponsorId')
  async update(
    @Param('workspaceId') workspaceId: string,
    @Param('sponsorId') sponsorId: string,
    @Body() dto: UpdateSponsorDto,
    @Req() req: any,
  ): Promise<ApiResponse> {
    return { data: await this.sponsors.update(workspaceId, sponsorId, dto, req.user.id) };
  }

  @Post('events/:eventId/sponsors')
  async attach(@Param('eventId') eventId: string, @Body() dto: AttachEventSponsorDto, @Req() req: any): Promise<ApiResponse> {
    return { data: await this.sponsors.attach(eventId, dto, req.user.id, req.user.role) };
  }

  @Delete('events/:eventId/sponsors/:sponsorId')
  async detach(
    @Param('eventId') eventId: string,
    @Param('sponsorId') sponsorId: string,
    @Req() req: any,
  ): Promise<ApiResponse> {
    return { data: await this.sponsors.detach(eventId, sponsorId, req.user.id, req.user.role) };
  }
}
