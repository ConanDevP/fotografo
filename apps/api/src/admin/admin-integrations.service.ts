import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/services/prisma.service';

@Injectable()
export class AdminIntegrationsService {
  constructor(private readonly prisma: PrismaService) {}

  async getStats() {
    const now = new Date();
    const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const activeWhere: Prisma.ApiClientWhereInput = {
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      workspace: { deletedAt: null },
    };
    const [total, active, revoked, expired, usedLast24h, workspaces] = await Promise.all([
      this.prisma.apiClient.count(),
      this.prisma.apiClient.count({ where: activeWhere }),
      this.prisma.apiClient.count({ where: { revokedAt: { not: null } } }),
      this.prisma.apiClient.count({ where: { revokedAt: null, expiresAt: { lte: now } } }),
      this.prisma.apiClient.count({ where: { ...activeWhere, lastUsedAt: { gte: last24h } } }),
      this.prisma.apiClient.findMany({ where: activeWhere, distinct: ['workspaceId'], select: { workspaceId: true } }),
    ]);
    return { total, active, revoked, expired, usedLast24h, workspacesWithActiveKeys: workspaces.length };
  }

  async list(
    page = 1,
    limit = 20,
    filters: { search?: string; status?: string; workspaceId?: string } = {},
  ) {
    page = Math.max(1, page);
    limit = Math.min(100, Math.max(1, limit));
    const now = new Date();
    const where: any = {};
    if (filters.workspaceId) where.workspaceId = filters.workspaceId;
    if (filters.search?.trim()) {
      const search = filters.search.trim();
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { keyPrefix: { contains: search, mode: 'insensitive' } },
        { workspace: { name: { contains: search, mode: 'insensitive' } } },
        { workspace: { slug: { contains: search, mode: 'insensitive' } } },
        { workspace: { owner: { email: { contains: search, mode: 'insensitive' } } } },
      ];
    }
    if (filters.status === 'active') {
      where.AND = [{ revokedAt: null }, { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }];
    } else if (filters.status === 'revoked') {
      where.revokedAt = { not: null };
    } else if (filters.status === 'expired') {
      where.revokedAt = null;
      where.expiresAt = { lte: now };
    }

    const [items, total] = await Promise.all([
      this.prisma.apiClient.findMany({
        where,
        select: {
          id: true,
          name: true,
          keyPrefix: true,
          scopes: true,
          environment: true,
          expiresAt: true,
          lastUsedAt: true,
          revokedAt: true,
          createdAt: true,
          workspace: {
            select: {
              id: true,
              name: true,
              slug: true,
              deletedAt: true,
              owner: { select: { id: true, name: true, email: true } },
            },
          },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.apiClient.count({ where }),
    ]);
    return { items, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
  }

  async revoke(clientId: string, adminUserId: string, reason?: string) {
    const client = await this.prisma.apiClient.findUnique({
      where: { id: clientId },
      select: { id: true, workspaceId: true, name: true, keyPrefix: true, revokedAt: true },
    });
    if (!client) throw new NotFoundException('Integración no encontrada');
    if (client.revokedAt) return { revoked: true, alreadyRevoked: true, revokedAt: client.revokedAt };

    const revokedAt = new Date();
    await this.prisma.$transaction([
      this.prisma.apiClient.update({ where: { id: clientId }, data: { revokedAt } }),
      this.prisma.auditLog.create({
        data: {
          userId: adminUserId,
          action: 'API_CLIENT_REVOKED_BY_ADMIN',
          data: {
            apiClientId: client.id,
            workspaceId: client.workspaceId,
            name: client.name,
            keyPrefix: client.keyPrefix,
            reason: reason?.trim() || null,
          },
        },
      }),
    ]);
    return { revoked: true, alreadyRevoked: false, revokedAt };
  }
}
