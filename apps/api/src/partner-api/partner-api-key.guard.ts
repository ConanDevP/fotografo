import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createHash, timingSafeEqual } from 'crypto';
import { PrismaService } from '../common/services/prisma.service';
import { PARTNER_SCOPES_METADATA } from './require-partner-scopes.decorator';
import { PartnerApiScope } from './partner-api.scopes';
import { EnterpriseAccessService } from './enterprise-access.service';

@Injectable()
export class PartnerApiKeyGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService, private readonly reflector: Reflector, private readonly enterpriseAccess: EnterpriseAccessService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<any>();
    const apiKey = this.extractApiKey(request);
    const parsed = /^lm_live_([a-f0-9]{16})_([A-Za-z0-9_-]{40,})$/.exec(apiKey);
    if (!parsed) throw new UnauthorizedException('Credencial API inválida');

    const client = await this.prisma.apiClient.findUnique({
      where: { keyPrefix: parsed[1] },
      include: { workspace: { select: { id: true, ownerId: true, deletedAt: true } } },
    });
    if (!client || client.revokedAt || client.workspace.deletedAt) {
      throw new UnauthorizedException('Credencial API inválida');
    }
    if (client.expiresAt && client.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException('La credencial API ha expirado');
    }

    const actual = Buffer.from(createHash('sha256').update(apiKey).digest('hex'));
    const expected = Buffer.from(client.secretHash);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new UnauthorizedException('Credencial API inválida');
    }

    const actor = await this.prisma.user.findFirst({
      where: { id: client.createdById, deletedAt: null },
      select: { id: true, role: true },
    });
    if (!actor) throw new UnauthorizedException('La cuenta que creó esta credencial ya no está activa');
    if (actor.role !== 'ADMIN' && client.workspace.ownerId !== actor.id) {
      const membership = await this.prisma.workspaceMember.findFirst({
        where: {
          workspaceId: client.workspaceId,
          userId: actor.id,
          status: 'ACTIVE',
          role: { in: ['OWNER', 'ADMIN'] },
        },
        select: { id: true },
      });
      if (!membership) {
        throw new UnauthorizedException('La cuenta que creó esta credencial ya no tiene acceso al workspace');
      }
    }

    const required = this.reflector.getAllAndOverride<PartnerApiScope[]>(PARTNER_SCOPES_METADATA, [
      context.getHandler(),
      context.getClass(),
    ]) || [];
    const granted = new Set(client.scopes);
    const missing = required.filter(scope => !granted.has(scope));
    if (missing.length) throw new ForbiddenException(`Falta el permiso API: ${missing.join(', ')}`);
    await this.enterpriseAccess.authorizeExistingClient(client.workspaceId, client.scopes as PartnerApiScope[], required);

    request.partner = {
      apiClientId: client.id,
      workspaceId: client.workspaceId,
      actorUserId: actor.id,
      actorRole: actor.role,
      keyPrefix: client.keyPrefix,
      scopes: client.scopes,
    };

    const stale = !client.lastUsedAt || client.lastUsedAt.getTime() < Date.now() - 5 * 60_000;
    if (stale) {
      void this.prisma.apiClient.updateMany({
        where: { id: client.id, OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: new Date(Date.now() - 5 * 60_000) } }] },
        data: { lastUsedAt: new Date() },
      }).catch(() => undefined);
    }
    return true;
  }

  private extractApiKey(request: any): string {
    const authorization = String(request.headers?.authorization || '');
    if (/^Bearer\s+/i.test(authorization)) return authorization.replace(/^Bearer\s+/i, '').trim();
    const header = request.headers?.['x-api-key'];
    if (typeof header === 'string') return header.trim();
    throw new UnauthorizedException('Incluye la credencial en Authorization: Bearer <api-key>');
  }
}
