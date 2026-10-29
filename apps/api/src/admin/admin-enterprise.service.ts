import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/services/prisma.service';
import { UpsertEnterpriseAccountDto } from './dto/admin-enterprise.dto';
import { PILOT_PRESET } from './enterprise-pilot.preset';

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

  /**
   * Aprobación en un clic de una solicitud: pone la cuenta ACTIVE y habilita la
   * Partner API a la vez. Evita el error de dejar el estado ACTIVE pero la API
   * desactivada, que hacía reaparecer el botón de "solicitar acceso".
   *
   * El plan efectivo (comisión, cupo, funciones) lo resuelve BillingService a
   * partir de la propia cuenta Enterprise activa: no hace falta crear aquí una
   * suscripción aparte.
   */
  async approve(workspaceId: string, adminId: string) {
    const account = await this.prisma.enterpriseAccount.findUnique({
      where: { workspaceId },
      select: { id: true, contractStart: true },
    });
    if (!account) throw new NotFoundException('Este espacio no tiene una solicitud/cuenta Enterprise');
    return this.prisma.$transaction(async tx => {
      const updated = await tx.enterpriseAccount.update({
        where: { workspaceId },
        data: {
          status: 'ACTIVE',
          partnerApiEnabled: true,
          contractStart: account.contractStart ?? new Date(),
          updatedById: adminId,
        },
      });
      await tx.auditLog.create({
        data: { userId: adminId, action: 'ENTERPRISE_ACCESS_APPROVED', data: { workspaceId } },
      });
      return updated;
    });
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

  /**
   * Abre un piloto de prueba con topes bajos y fecha de fin, en un clic. Es el
   * primer paso de la venta: el cliente integra y prueba sin riesgo para ti, y
   * al vencer el piloto el propio contrato deja de valer.
   */
  async startPilot(workspaceId: string, adminId: string, days: number = PILOT_PRESET.days, contactEmail?: string) {
    const workspace = await this.prisma.workspace.findUnique({ where: { id: workspaceId }, select: { id: true, name: true } });
    if (!workspace) throw new NotFoundException('Workspace no encontrado');
    const existing = await this.prisma.enterpriseAccount.findUnique({ where: { workspaceId }, select: { status: true } });
    if (existing?.status === 'ACTIVE') throw new BadRequestException('Este espacio ya tiene un contrato activo');
    const start = new Date();
    const end = new Date(start.getTime() + Math.min(Math.max(days, 1), 90) * 24 * 60 * 60 * 1000);
    const data = { ...PILOT_PRESET.account, status: 'PILOT' as const, contractStart: start, contractEnd: end, ...(contactEmail ? { businessContactEmail: contactEmail } : {}) };
    return this.prisma.$transaction(async tx => {
      const account = await tx.enterpriseAccount.upsert({
        where: { workspaceId },
        create: { workspaceId, ...data, createdById: adminId, updatedById: adminId },
        update: { ...data, updatedById: adminId },
      });
      await tx.auditLog.create({ data: { userId: adminId, action: 'ENTERPRISE_PILOT_STARTED', data: { workspaceId, workspaceName: workspace.name, contractEnd: end.toISOString() } } });
      return account;
    });
  }
}
