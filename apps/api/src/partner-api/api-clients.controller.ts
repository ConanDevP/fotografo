import { Body, Controller, Delete, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiResponse } from '@shared/types';
import { ApiClientsService } from './api-clients.service';
import { CreateApiClientDto, RotateApiClientDto } from './dto/api-client.dto';

@Controller('workspaces/:workspaceId/api-clients')
@UseGuards(AuthGuard('jwt'))
export class ApiClientsController {
  constructor(private readonly clients: ApiClientsService) {}

  @Get()
  async list(@Param('workspaceId') workspaceId: string, @Req() req: any): Promise<ApiResponse> {
    return { data: await this.clients.list(workspaceId, req.user.id) };
  }

  @Post()
  async create(
    @Param('workspaceId') workspaceId: string,
    @Body() dto: CreateApiClientDto,
    @Req() req: any,
  ): Promise<ApiResponse> {
    return { data: await this.clients.create(workspaceId, req.user.id, dto) };
  }

  @Post(':clientId/rotate')
  async rotate(
    @Param('workspaceId') workspaceId: string,
    @Param('clientId') clientId: string,
    @Body() dto: RotateApiClientDto,
    @Req() req: any,
  ): Promise<ApiResponse> {
    return { data: await this.clients.rotate(workspaceId, clientId, req.user.id, dto) };
  }

  @Delete(':clientId')
  async revoke(
    @Param('workspaceId') workspaceId: string,
    @Param('clientId') clientId: string,
    @Req() req: any,
  ): Promise<ApiResponse> {
    return { data: await this.clients.revoke(workspaceId, clientId, req.user.id) };
  }
}
