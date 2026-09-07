import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { SubscriptionStatus } from '@prisma/client';
import { PrismaService } from '../common/services/prisma.service';
import { UpsertEnterpriseAccountDto } from './dto/admin-enterprise.dto';

/** Plan que se concede al aprobar una cuenta Business si no paga ya uno. */
const BUSINESS_PLAN_SLUG = 'organizacion';
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

@Injectable()
export class AdminEnterpriseService {
  private readonly logger = new Logger(AdminEnterpriseService.name);

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
   */
  async approve(workspaceId: string, adminId: string) {
    const account = await this.prisma.enterpriseAccount.findUnique({
      where: { workspaceId },
      select: { id: true, contractStart: true, contractEnd: true },
    });
    if (!account) throw new NotFoundException('Este espacio no tiene una solicitud/cuenta Enterprise');
    const updated = await this.prisma.$transaction(async tx => {
      const acc = await tx.enterpriseAccount.update({
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
      return acc;
    });

    // Una cuenta Business no puede quedarse en el plan gratuito: sin un plan de
    // pago, su comisión y su cupo seguirían siendo los de Arranque aunque el
    // panel diga "Empresa". Se le concede el plan superior (misma vía que
    // "Acceso a planes"), salvo que ya pague uno por Stripe. Va fuera de la
    // transacción para que un fallo aquí no revierta la aprobación.
    const planNote = await this.ensureBusinessPlan(
      workspaceId,
      account.contractEnd,
      adminId,
    ).catch(error => {
      this.logger.warn(
        `No se pudo conceder el plan al aprobar Business en ${workspaceId}: ${
          error instanceof Error ? error.message : 'error desconocido'
        }`,
      );
      return 'No se pudo asignar el plan automáticamente. Hazlo desde "Acceso a planes".';
    });

    return { ...updated, planNote };
  }

  /**
   * Garantiza que el espacio tenga al menos el plan Business concedido. Devuelve
   * un aviso legible si no se pudo (y no lanza), o `null` si quedó en orden.
   */
  private async ensureBusinessPlan(
    workspaceId: string,
    contractEnd: Date | null,
    adminId: string,
  ): Promise<string | null> {
    const [plan, existing, workspace] = await Promise.all([
      this.prisma.plan.findUnique({ where: { slug: BUSINESS_PLAN_SLUG } }),
      this.prisma.subscription.findUnique({ where: { workspaceId } }),
      this.prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: { name: true, storageBytesUsed: true },
      }),
    ]);
    if (!workspace) return null;
    if (!plan?.isActive) {
      return `No existe el plan "${BUSINESS_PLAN_SLUG}"; ejecuta el seed de planes.`;
    }
    // Si ya paga un plan por Stripe, no se toca: lo gestiona el cliente.
    if (existing?.stripeSubscriptionId && existing.status === SubscriptionStatus.ACTIVE) {
      return null;
    }
    // Si ya tiene una concesión vigente de este mismo plan, nada que hacer.
    if (
      existing?.status === SubscriptionStatus.ACTIVE &&
      existing.planId === plan.id &&
      (!existing.adminGrantedUntil || existing.adminGrantedUntil > new Date())
    ) {
      return null;
    }
    if (workspace.storageBytesUsed > plan.includedStorageBytes) {
      return 'El espacio usado supera el cupo del plan; concédelo a mano desde "Acceso a planes".';
    }

    const until =
      contractEnd && contractEnd.getTime() > Date.now()
        ? contractEnd
        : new Date(Date.now() + YEAR_MS);

    await this.prisma.$transaction(async tx => {
      await tx.subscription.upsert({
        where: { workspaceId },
        create: {
          workspaceId,
          planId: plan.id,
          status: SubscriptionStatus.ACTIVE,
          extraStorageBlocks: 0,
          adminGrantedUntil: until,
          adminGrantReason: 'Cuenta Business aprobada',
          adminGrantedById: adminId,
        },
        update: {
          planId: plan.id,
          status: SubscriptionStatus.ACTIVE,
          cancelAtPeriodEnd: false,
          adminGrantedUntil: until,
          adminGrantReason: 'Cuenta Business aprobada',
          adminGrantedById: adminId,
        },
      });
      await tx.auditLog.create({
        data: {
          userId: adminId,
          action: 'PLAN_ACCESS_GRANTED_BY_ADMIN',
          data: {
            workspaceId,
            workspaceName: workspace.name,
            planSlug: plan.slug,
            expiresAt: until.toISOString(),
            reason: 'Cuenta Business aprobada',
            via: 'enterprise-approve',
          },
        },
      });
    });
    return null;
  }

  async upsert(workspaceId: string, dto: UpsertEnterpriseAccountDto, adminId: string) {
    const workspace = await this.prisma.workspace.findUnique({ where: { id: workspaceId }, select: { id: true, name: true } });
    if (!workspace) throw new NotFoundException('Workspace no encontrado');
    const start = dto.contractStart ? new Date(dto.contractStart) : null;
    const end = dto.contractEnd ? new Date(dto.contractEnd) : null;
    if (start && end && end <= start) throw new BadRequestException('El fin del contrato debe ser posterior al inicio');
    const data = { ...dto, currency: (dto.currency || 'USD').toUpperCase(), contractStart: start, contractEnd: end };
    const account = await this.prisma.$transaction(async tx => {
      const saved = await tx.enterpriseAccount.upsert({ where: { workspaceId }, create: { workspaceId, ...data, createdById: adminId, updatedById: adminId }, update: { ...data, updatedById: adminId } });
      await tx.auditLog.create({ data: { userId: adminId, action: 'ENTERPRISE_ACCOUNT_UPSERTED', data: { workspaceId, workspaceName: workspace.name, status: dto.status, partnerApiEnabled: dto.partnerApiEnabled, contractEnd: dto.contractEnd || null } } });
      return saved;
    });

    // Un contrato que pasa a activo arrastra el plan: si no, el panel del
    // cliente seguiría en Arranque. Best-effort, no revierte el guardado.
    let planNote: string | null = null;
    if (['ACTIVE', 'PILOT'].includes(dto.status)) {
      planNote = await this.ensureBusinessPlan(workspaceId, end, adminId).catch(error => {
        this.logger.warn(
          `No se pudo conceder el plan al guardar el contrato de ${workspaceId}: ${
            error instanceof Error ? error.message : 'error desconocido'
          }`,
        );
        return 'No se pudo asignar el plan automáticamente. Hazlo desde "Acceso a planes".';
      });
    }

    return { ...account, planNote };
  }
}
