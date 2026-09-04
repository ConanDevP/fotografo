import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { WorkspaceRole } from '@prisma/client';
import { PrismaService } from '../common/services/prisma.service';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { CreateApiClientDto, RotateApiClientDto } from './dto/api-client.dto';

@Injectable()
export class ApiClientsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly workspaces: WorkspacesService,
  ) {}

  async list(workspaceId: string, userId: string) {
    await this.assertCanManage(workspaceId, userId);
    return this.prisma.apiClient.findMany({
      where: { workspaceId },
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
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async create(workspaceId: string, userId: string, dto: CreateApiClientDto) {
    await this.assertCanManage(workspaceId, userId);
    const expiry = this.validateExpiry(dto.expiresAt);
    const credential = this.generateCredential();
    const client = await this.prisma.apiClient.create({
      data: {
        workspaceId,
        createdById: userId,
        name: dto.name.trim(),
        keyPrefix: credential.prefix,
        secretHash: credential.hash,
        scopes: [...new Set(dto.scopes)],
        environment: 'LIVE',
        expiresAt: expiry,
      },
      select: {
        id: true,
        name: true,
        keyPrefix: true,
        scopes: true,
        environment: true,
        expiresAt: true,
        createdAt: true,
      },
    });
    return { ...client, apiKey: credential.apiKey };
  }

  async rotate(workspaceId: string, clientId: string, userId: string, dto: RotateApiClientDto) {
    await this.assertCanManage(workspaceId, userId);
    await this.findClient(workspaceId, clientId);
    const expiry = dto.expiresAt === undefined ? undefined : this.validateExpiry(dto.expiresAt);
    const credential = this.generateCredential();
    const client = await this.prisma.apiClient.update({
      where: { id: clientId },
      data: {
        keyPrefix: credential.prefix,
        secretHash: credential.hash,
        revokedAt: null,
        ...(expiry !== undefined ? { expiresAt: expiry } : {}),
      },
      select: { id: true, name: true, keyPrefix: true, scopes: true, expiresAt: true },
    });
    return { ...client, apiKey: credential.apiKey };
  }

  async revoke(workspaceId: string, clientId: string, userId: string) {
    await this.assertCanManage(workspaceId, userId);
    await this.findClient(workspaceId, clientId);
    await this.prisma.apiClient.update({
      where: { id: clientId },
      data: { revokedAt: new Date() },
    });
    return { revoked: true };
  }

  private async assertCanManage(workspaceId: string, userId: string) {
    await this.workspaces.assertAccess(workspaceId, userId, [WorkspaceRole.OWNER, WorkspaceRole.ADMIN]);
  }

  private async findClient(workspaceId: string, clientId: string) {
    const client = await this.prisma.apiClient.findFirst({ where: { id: clientId, workspaceId } });
    if (!client) throw new NotFoundException('Credencial API no encontrada');
    return client;
  }

  private generateCredential() {
    const prefix = randomBytes(8).toString('hex');
    const secret = randomBytes(32).toString('base64url');
    const apiKey = `lm_live_${prefix}_${secret}`;
    return { prefix, apiKey, hash: createHash('sha256').update(apiKey).digest('hex') };
  }

  private validateExpiry(value?: string): Date | null {
    if (!value) return null;
    const expiry = new Date(value);
    if (expiry.getTime() <= Date.now()) throw new BadRequestException('La expiración debe estar en el futuro');
    return expiry;
  }
}
