import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Throttle } from '@nestjs/throttler';
import { WorkspaceRole } from '@prisma/client';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { EnterpriseAccessService } from './enterprise-access.service';
import { RequestEnterpriseAccessDto } from './dto/request-enterprise-access.dto';

@Controller('workspaces/:workspaceId/enterprise-access')
@UseGuards(AuthGuard('jwt'))
export class EnterpriseAccessController {
  constructor(private readonly access: EnterpriseAccessService, private readonly workspaces: WorkspacesService) {}

  @Get()
  async get(@Param('workspaceId') workspaceId: string, @Req() req: any) {
    await this.workspaces.assertAccess(workspaceId, req.user.id, [WorkspaceRole.OWNER, WorkspaceRole.ADMIN]);
    return { data: await this.access.dashboard(workspaceId) };
  }

  /** Solicitud de acceso a la API empresarial. No concede nada: genera un lead. */
  @Post('request')
  @Throttle(6, 3600)
  async request(
    @Param('workspaceId') workspaceId: string,
    @Body() dto: RequestEnterpriseAccessDto,
    @Req() req: any,
  ) {
    await this.workspaces.assertAccess(workspaceId, req.user.id, [WorkspaceRole.OWNER, WorkspaceRole.ADMIN]);
    return { data: await this.access.requestAccess(workspaceId, req.user.id, req.user.email, dto) };
  }
}
