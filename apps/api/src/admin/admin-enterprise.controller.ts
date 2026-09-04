import { Body, Controller, DefaultValuePipe, Get, Param, ParseIntPipe, Put, Query, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { UserRole } from '@shared/types';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { AdminEnterpriseService } from './admin-enterprise.service';
import { UpsertEnterpriseAccountDto } from './dto/admin-enterprise.dto';

@Controller('admin/enterprise')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(UserRole.ADMIN)
export class AdminEnterpriseController {
  constructor(private readonly service: AdminEnterpriseService) {}
  @Get() async list(@Query('search') search = '', @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number, @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number) {
    const result = await this.service.list(search, page, limit); return { data: result.items, meta: { pagination: result.pagination } };
  }
  @Put(':workspaceId') async upsert(@Param('workspaceId') workspaceId: string, @Body() dto: UpsertEnterpriseAccountDto, @Req() req: any) {
    return { data: await this.service.upsert(workspaceId, dto, req.user.id) };
  }
}
