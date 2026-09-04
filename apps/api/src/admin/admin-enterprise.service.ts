import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/services/prisma.service';
import { UpsertEnterpriseAccountDto } from './dto/admin-enterprise.dto';

@Injectable()
export class AdminEnterpriseService {
  constructor(private readonly prisma: PrismaService) {}

  async list(search = '', page = 1, limit = 50) {
    page = Math.max(1, page); limit = Math.min(100, Math.max(1, limit));
    const term = search.trim();
    const where = term ? { OR: [
      { name: { contains: term, mode: 'insensitive' as const } },
      { slug: { contains: term, mode: 'insensitive' as const } },
      { owner: { email: { contains: term, mode: 'insensitive' as const } } },
      { enterpriseAccount: { legalName: { contains: term, mode: 'insensitive' as const } } },
    ] } : {};
    const [items, total] = await Promise.all([
      this.prisma.workspace.findMany({ where, select: { id: true, name: true, slug: true, createdAt: true, owner: { select: { name: true, email: true } }, enterpriseAccount: true, partnerApiUsage: { orderBy: { period: 'desc' }, take: 1 } }, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
      this.prisma.workspace.count({ where }),
    ]);
    return { items: items.map(item => ({ ...item, partnerApiUsage: item.partnerApiUsage.map(u => ({ ...u, requestCount: u.requestCount.toString(), faceSearchCount: u.faceSearchCount.toString() })) })), pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
  }

  async upsert(workspaceId: string, dto: UpsertEnterpriseAccountDto, adminId: string) {
    const workspace = await this.prisma.workspace.findUnique({ where: { id: workspaceId }, select: { id: true, name: true } });
    if (!workspace) throw new NotFoundException('Workspace no encontrado');
    const start = dto.contractStart ? new Date(dto.contractStart) : null;
    const end = dto.contractEnd ? new Date(dto.contractEnd) : null;
    if (start && end && end <= start) throw new BadRequestException('El fin del contrato debe ser posterior al inicio');
    const data = { ...dto, currency: (dto.currency || 'USD').toUpperCase(), contractStart: start, contractEnd: end };
    return this.prisma.$transaction(async tx => {
      const account = await tx.enterpriseAccount.upsert({ where: { workspaceId }, create: { workspaceId, ...data, createdById: adminId, updatedById: adminId }, update: { ...data, updatedById: adminId } });
      await tx.auditLog.create({ data: { userId: adminId, action: 'ENTERPRISE_ACCOUNT_UPSERTED', data: { workspaceId, workspaceName: workspace.name, status: dto.status, partnerApiEnabled: dto.partnerApiEnabled, contractEnd: dto.contractEnd || null } } });
      return account;
    });
  }
}
