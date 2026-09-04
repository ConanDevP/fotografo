import { Body, Controller, DefaultValuePipe, Get, Param, ParseIntPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { UserRole } from '@shared/types';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { AdminPlanAccessService } from './admin-plan-access.service';
import { GrantAdminPlanDto, RevokeAdminPlanDto } from './dto/admin-plan-access.dto';

@Controller('admin/plan-access')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(UserRole.ADMIN)
export class AdminPlanAccessController {
  constructor(private readonly service: AdminPlanAccessService) {}

  @Get()
  async list(@Query('search') search = '', @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number, @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number) {
    const result = await this.service.list(search, page, limit);
    return { data: result.items, meta: { pagination: result.pagination, plans: result.plans } };
  }

  @Post(':workspaceId/grant')
  async grant(@Param('workspaceId') workspaceId: string, @Body() dto: GrantAdminPlanDto, @Req() req: any) {
    return { data: await this.service.grant(workspaceId, dto, req.user.id) };
  }

  @Post(':workspaceId/revoke')
  async revoke(@Param('workspaceId') workspaceId: string, @Body() dto: RevokeAdminPlanDto, @Req() req: any) {
    return { data: await this.service.revoke(workspaceId, dto.reason, req.user.id) };
  }
}
