import { Body, Controller, Delete, Get, NotFoundException, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiResponse } from '@shared/types';
import { PrismaService } from '../common/services/prisma.service';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { WorkspaceRole } from '@prisma/client';
import { CreatePartnerWebhookDto, UpdatePartnerWebhookDto } from './dto/partner-webhook.dto';
import { PartnerWebhooksService } from './partner-webhooks.service';

@Controller('workspaces/:workspaceId/api-clients/:clientId/webhooks')
@UseGuards(AuthGuard('jwt'))
export class WorkspaceWebhooksController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly workspaces: WorkspacesService,
    private readonly webhooks: PartnerWebhooksService,
  ) {}

  @Get()
  async list(@Param('workspaceId') workspaceId: string, @Param('clientId') clientId: string, @Req() req: any): Promise<ApiResponse> {
    return { data: await this.webhooks.list(await this.principal(workspaceId, clientId, req.user)) };
  }

  @Post()
  async create(@Param('workspaceId') workspaceId: string, @Param('clientId') clientId: string, @Req() req: any, @Body() dto: CreatePartnerWebhookDto): Promise<ApiResponse> {
    return { data: await this.webhooks.create(await this.principal(workspaceId, clientId, req.user), dto) };
  }

  @Patch(':endpointId')
  async update(@Param('workspaceId') workspaceId: string, @Param('clientId') clientId: string, @Param('endpointId') endpointId: string, @Req() req: any, @Body() dto: UpdatePartnerWebhookDto): Promise<ApiResponse> {
    return { data: await this.webhooks.update(await this.principal(workspaceId, clientId, req.user), endpointId, dto) };
  }

  @Delete(':endpointId')
  async remove(@Param('workspaceId') workspaceId: string, @Param('clientId') clientId: string, @Param('endpointId') endpointId: string, @Req() req: any): Promise<ApiResponse> {
    return { data: await this.webhooks.remove(await this.principal(workspaceId, clientId, req.user), endpointId) };
  }

  @Post(':endpointId/rotate-secret')
  async rotate(@Param('workspaceId') workspaceId: string, @Param('clientId') clientId: string, @Param('endpointId') endpointId: string, @Req() req: any): Promise<ApiResponse> {
    return { data: await this.webhooks.rotateSecret(await this.principal(workspaceId, clientId, req.user), endpointId) };
  }

  @Get(':endpointId/deliveries')
  async deliveries(@Param('workspaceId') workspaceId: string, @Param('clientId') clientId: string, @Param('endpointId') endpointId: string, @Req() req: any): Promise<ApiResponse> {
    return { data: await this.webhooks.deliveries(await this.principal(workspaceId, clientId, req.user), endpointId) };
  }

  @Post('deliveries/:deliveryId/retry')
  async retry(@Param('workspaceId') workspaceId: string, @Param('clientId') clientId: string, @Param('deliveryId') deliveryId: string, @Req() req: any): Promise<ApiResponse> {
    return { data: await this.webhooks.retry(await this.principal(workspaceId, clientId, req.user), deliveryId) };
  }

  private async principal(workspaceId: string, clientId: string, user: any) {
    await this.workspaces.assertAccess(workspaceId, user.id, [WorkspaceRole.OWNER, WorkspaceRole.ADMIN]);
    const client = await this.prisma.apiClient.findFirst({ where: { id: clientId, workspaceId, revokedAt: null }, select: { id: true, keyPrefix: true, scopes: true } });
    if (!client) throw new NotFoundException('Credencial API no encontrada');
    return { apiClientId: client.id, workspaceId, actorUserId: user.id, actorRole: user.role, keyPrefix: client.keyPrefix, scopes: client.scopes as any };
  }
}
