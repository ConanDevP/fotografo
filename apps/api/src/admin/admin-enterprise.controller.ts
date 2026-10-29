import { Body, Controller, DefaultValuePipe, Get, Param, ParseIntPipe, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { UserRole } from '@shared/types';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { AdminEnterpriseService } from './admin-enterprise.service';
import { UpsertEnterpriseAccountDto } from './dto/admin-enterprise.dto';
import { EnterpriseBillingService } from '../partner-api/enterprise-billing.service';

@Controller('admin/enterprise')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(UserRole.ADMIN)
export class AdminEnterpriseController {
  constructor(private readonly service: AdminEnterpriseService, private readonly billing: EnterpriseBillingService) {}
  @Get() async list(@Query('search') search = '', @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number, @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number) {
    const result = await this.service.list(search, page, limit); return { data: result.items, meta: { pagination: result.pagination } };
  }
  @Put(':workspaceId') async upsert(@Param('workspaceId') workspaceId: string, @Body() dto: UpsertEnterpriseAccountDto, @Req() req: any) {
    return { data: await this.service.upsert(workspaceId, dto, req.user.id) };
  }

  /** Aprobación en un clic: ACTIVE + Partner API habilitada. */
  @Post(':workspaceId/approve') async approve(@Param('workspaceId') workspaceId: string, @Req() req: any) {
    return { data: await this.service.approve(workspaceId, req.user.id) };
  }

  /** Abre un piloto de prueba (topes bajos, 30 días, claves `lm_test_`). */
  @Post(':workspaceId/pilot') async pilot(@Param('workspaceId') workspaceId: string, @Body() body: { days?: number; contactEmail?: string }, @Req() req: any) {
    return { data: await this.service.startPilot(workspaceId, req.user.id, body?.days, body?.contactEmail) };
  }

  /** Factura ahora lo que corresponda al contrato (cuota anual y exceso). Es idempotente. */
  @Post(':workspaceId/invoice') async invoice(@Param('workspaceId') workspaceId: string) {
    return { data: await this.billing.invoiceWorkspace(workspaceId) };
  }
}
