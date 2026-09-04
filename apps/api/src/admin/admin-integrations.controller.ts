import { Body, Controller, DefaultValuePipe, Get, Param, ParseIntPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiResponse, UserRole } from '@shared/types';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { AdminIntegrationsService } from './admin-integrations.service';

class RevokeIntegrationDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

@Controller('admin/integrations')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(UserRole.ADMIN)
export class AdminIntegrationsController {
  constructor(private readonly integrations: AdminIntegrationsService) {}

  @Get('stats')
  async stats(): Promise<ApiResponse> {
    return { data: await this.integrations.getStats() };
  }

  @Get()
  async list(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('search') search?: string,
    @Query('status') status?: string,
    @Query('workspaceId') workspaceId?: string,
  ): Promise<ApiResponse> {
    const result = await this.integrations.list(page, limit, { search, status, workspaceId });
    return { data: result.items, meta: { pagination: result.pagination } };
  }

  @Post(':clientId/revoke')
  async revoke(
    @Param('clientId') clientId: string,
    @Body() dto: RevokeIntegrationDto,
    @Req() req: any,
  ): Promise<ApiResponse> {
    return { data: await this.integrations.revoke(clientId, req.user.id, dto.reason) };
  }
}
