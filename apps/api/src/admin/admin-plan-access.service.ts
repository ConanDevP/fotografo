import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { SubscriptionStatus } from '@prisma/client';
import { PrismaService } from '../common/services/prisma.service';
import { GrantAdminPlanDto } from './dto/admin-plan-access.dto';

@Injectable()
export class AdminPlanAccessService {
  constructor(private readonly prisma: PrismaService) {}

  async list(search = '', page = 1, limit = 50) {
    page = Math.max(1, page);
    limit = Math.min(100, Math.max(1, limit));
    const term = search.trim();
    const where = term ? {
      OR: [
        { name: { contains: term, mode: 'insensitive' as const } },
        { slug: { contains: term, mode: 'insensitive' as const } },
        { owner: { email: { contains: term, mode: 'insensitive' as const } } },
      ],
    } : {};
    const [items, total, plans] = await Promise.all([
      this.prisma.workspace.findMany({
        where,
        select: {
          id: true, name: true, slug: true, storageBytesUsed: true, createdAt: true,
          owner: { select: { id: true, name: true, email: true } },
          subscription: { include: { plan: true } },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.workspace.count({ where }),
      this.prisma.plan.findMany({ where: { isActive: true }, orderBy: { sortOrder: 'asc' } }),
    ]);
    return {
      items: items.map(item => ({ ...item, storageBytesUsed: item.storageBytesUsed.toString(), subscription: item.subscription ? {
        ...item.subscription,
        plan: { ...item.subscription.plan, includedStorageBytes: item.subscription.plan.includedStorageBytes.toString(), commissionPercent: Number(item.subscription.plan.commissionPercent), sharePhotoCents: Number(item.subscription.plan.sharePhotoCents) },
      } : null })),
      plans: plans.map(plan => ({ slug: plan.slug, name: plan.name, priceCents: plan.priceCents })),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
  }

  async grant(workspaceId: string, dto: GrantAdminPlanDto, adminId: string) {
    const expiresAt = new Date(dto.expiresAt);
    if (expiresAt <= new Date()) throw new BadRequestException('El vencimiento debe estar en el futuro');
    if (expiresAt.getTime() > Date.now() + 366 * 2 * 24 * 60 * 60 * 1000) {
      throw new BadRequestException('Una concesión no puede superar dos años');
    }
    const [workspace, plan, existing] = await Promise.all([
      this.prisma.workspace.findUnique({ where: { id: workspaceId }, select: { id: true, name: true, storageBytesUsed: true } }),
      this.prisma.plan.findUnique({ where: { slug: dto.planSlug } }),
      this.prisma.subscription.findUnique({ where: { workspaceId } }),
    ]);
    if (!workspace) throw new NotFoundException('Espacio no encontrado');
    if (!plan?.isActive) throw new NotFoundException('Plan no encontrado');
    if (existing?.stripeSubscriptionId && existing.status === SubscriptionStatus.ACTIVE) {
      throw new ConflictException('Este espacio tiene una suscripción pagada activa; modifícala mediante Stripe');
    }
    const allowance = plan.includedStorageBytes + (plan.extraStorageBlockBytes ?? 0n) * BigInt(dto.extraStorageBlocks);
    if (workspace.storageBytesUsed > allowance) throw new BadRequestException('El espacio usado supera el cupo del plan elegido');

    const reason = dto.reason.trim();
    const subscription = await this.prisma.$transaction(async tx => {
      const saved = await tx.subscription.upsert({
        where: { workspaceId },
        create: { workspaceId, planId: plan.id, status: SubscriptionStatus.ACTIVE, extraStorageBlocks: dto.extraStorageBlocks, adminGrantedUntil: expiresAt, adminGrantReason: reason, adminGrantedById: adminId },
        update: { planId: plan.id, status: SubscriptionStatus.ACTIVE, extraStorageBlocks: dto.extraStorageBlocks, cancelAtPeriodEnd: false, adminGrantedUntil: expiresAt, adminGrantReason: reason, adminGrantedById: adminId },
      });
      await tx.auditLog.create({ data: { userId: adminId, action: 'PLAN_ACCESS_GRANTED_BY_ADMIN', data: { workspaceId, workspaceName: workspace.name, planSlug: plan.slug, expiresAt: expiresAt.toISOString(), extraStorageBlocks: dto.extraStorageBlocks, reason } } });
      return saved;
    });
    return { ...subscription, plan: { slug: plan.slug, name: plan.name }, storageAllowanceBytes: allowance.toString() };
  }

  async revoke(workspaceId: string, reasonInput: string, adminId: string) {
    const existing = await this.prisma.subscription.findUnique({ where: { workspaceId }, include: { plan: true } });
    if (!existing) throw new NotFoundException('El espacio no tiene una suscripción explícita');
    if (existing.stripeSubscriptionId) throw new ConflictException('No se puede revocar aquí una suscripción pagada');
    const reason = reasonInput.trim();
    return this.prisma.$transaction(async tx => {
      const saved = await tx.subscription.update({ where: { workspaceId }, data: { status: SubscriptionStatus.CANCELED, adminGrantedUntil: new Date(), adminGrantReason: reason, adminGrantedById: adminId } });
      await tx.auditLog.create({ data: { userId: adminId, action: 'PLAN_ACCESS_REVOKED_BY_ADMIN', data: { workspaceId, previousPlan: existing.plan.slug, reason } } });
      return saved;
    });
  }
}
