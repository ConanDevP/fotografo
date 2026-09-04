import { Controller, Get, Param, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { WorkspaceRole } from '@prisma/client';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { EnterpriseAccessService } from './enterprise-access.service';

@Controller('workspaces/:workspaceId/enterprise-access')
@UseGuards(AuthGuard('jwt'))
export class EnterpriseAccessController {
  constructor(private readonly access: EnterpriseAccessService, private readonly workspaces: WorkspacesService) {}

  @Get()
  async get(@Param('workspaceId') workspaceId: string, @Req() req: any) {
    await this.workspaces.assertAccess(workspaceId, req.user.id, [WorkspaceRole.OWNER, WorkspaceRole.ADMIN]);
    return { data: await this.access.dashboard(workspaceId) };
  }
}
