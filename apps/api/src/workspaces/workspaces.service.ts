import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, WorkspaceRole } from '@prisma/client';
import { PrismaService } from '../common/services/prisma.service';
import { CreateWorkspaceDto } from './dto/create-workspace.dto';
import { UpdateWorkspaceDto } from './dto/update-workspace.dto';
import { UpdateBrandThemeDto } from './dto/update-brand-theme.dto';
import { AddWorkspaceMemberDto } from './dto/add-workspace-member.dto';
import { UpdateWorkspaceMemberDto } from './dto/update-workspace-member.dto';
import { randomBytes } from 'crypto';
import { resolveTxt } from 'dns/promises';
import { ConfigService } from '@nestjs/config';

const MANAGER_ROLES: WorkspaceRole[] = [
  WorkspaceRole.OWNER,
  WorkspaceRole.ADMIN,
  WorkspaceRole.EDITOR,
];

@Injectable()
export class WorkspacesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async create(dto: CreateWorkspaceDto, userId: string) {
    const slug = await this.generateUniqueSlug(dto.slug || dto.name);
    const customDomain = dto.customDomain ? this.normalizeCustomDomain(dto.customDomain) : undefined;
    if (customDomain) await this.assertDomainAvailable(customDomain);
    const brand = dto.brand || {};

    return this.prisma.$transaction(async tx => {
      return tx.workspace.create({
        data: {
          name: dto.name.trim(),
          slug,
          description: dto.description?.trim(),
          logoUrl: dto.logoUrl,
          coverUrl: dto.coverUrl,
          customDomain,
          customDomainVerificationToken: customDomain ? randomBytes(18).toString('hex') : undefined,
          contactEmail: dto.contactEmail,
          website: dto.website,
          instagram: dto.instagram,
          facebook: dto.facebook,
          isPublished: dto.isPublished ?? false,
          ownerId: userId,
          members: {
            create: { userId, role: WorkspaceRole.OWNER },
          },
          brandTheme: {
            create: {
              template: brand.template || 'editorial',
              primaryColor: brand.primaryColor || '#111111',
              secondaryColor: brand.secondaryColor || '#F5F1E8',
              accentColor: brand.accentColor || '#C6FF00',
              fontFamily: brand.fontFamily || 'Inter',
              heroTitle: brand.heroTitle || dto.name,
              heroSubtitle: brand.heroSubtitle || dto.description,
            },
          },
        },
        include: this.workspaceInclude(),
      });
    });
  }

  async createDefaultForPhotographer(user: { id: string; name?: string | null; email: string; slug?: string | null }) {
    const existing = await this.prisma.workspace.findFirst({
      where: { ownerId: user.id, deletedAt: null },
    });
    if (existing) return existing;

    return this.create({
      name: user.name || user.email.split('@')[0],
      slug: user.slug || undefined,
      contactEmail: user.email,
      isPublished: false,
    }, user.id);
  }

  async findMine(userId: string) {
    return this.prisma.workspace.findMany({
      where: {
        deletedAt: null,
        members: { some: { userId, status: 'ACTIVE' } },
      },
      include: {
        brandTheme: true,
        events: {
          where: { deletedAt: null },
          orderBy: { date: 'desc' },
          select: {
            id: true,
            name: true,
            slug: true,
            date: true,
            location: true,
            imageUrl: true,
            commerceMode: true,
            sponsorOverlayEnabled: true,
            isPublished: true,
            _count: { select: { photos: true } },
          },
        },
        members: {
          where: { userId },
          select: { role: true, status: true },
        },
        _count: { select: { events: true, members: true, sponsors: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  async findOneForMember(workspaceId: string, userId: string) {
    await this.assertAccess(workspaceId, userId);
    const workspace = await this.prisma.workspace.findFirst({
      where: { id: workspaceId, deletedAt: null },
      include: this.workspaceInclude(),
    });
    if (!workspace) throw new NotFoundException('Espacio no encontrado');
    return workspace;
  }

  async findPublicBySlug(slug: string) {
    const workspace = await this.prisma.workspace.findFirst({
      where: { slug, isPublished: true, deletedAt: null },
      include: {
        brandTheme: true,
        events: {
          where: { deletedAt: null, isPublished: true },
          orderBy: { date: 'desc' },
          select: {
            id: true,
            name: true,
            slug: true,
            date: true,
            location: true,
            imageUrl: true,
            commerceMode: true,
            sponsorOverlayEnabled: true,
            eventSponsors: {
              where: {
                status: 'ACTIVE',
                sponsor: { isActive: true },
                AND: [
                  { OR: [{ startsAt: null }, { startsAt: { lte: new Date() } }] },
                  { OR: [{ endsAt: null }, { endsAt: { gte: new Date() } }] },
                ],
              },
              orderBy: { priority: 'desc' },
              select: {
                priority: true,
                requiredOnFreeDownloads: true,
                placement: true,
                sponsor: { select: { id: true, name: true, logoUrl: true, websiteUrl: true } },
              },
            },
            _count: { select: { photos: { where: { status: 'PROCESSED', publicationStatus: 'APPROVED' } } } },
          },
        },
        sponsors: {
          where: { isActive: true },
          select: { id: true, name: true, logoUrl: true, websiteUrl: true },
        },
      },
    });
    if (!workspace) throw new NotFoundException('Espacio no encontrado');
    return workspace;
  }

  async findPublicByDomain(domain: string) {
    const normalized = this.normalizeCustomDomain(domain);
    const workspace = await this.prisma.workspace.findFirst({
      where: { customDomain: normalized, customDomainVerifiedAt: { not: null }, isPublished: true, deletedAt: null },
      select: { id: true, slug: true, customDomain: true },
    });
    if (!workspace) throw new NotFoundException('Dominio no asociado a un espacio publicado');
    return workspace;
  }

  async authorizeTlsDomain(domain: string) {
    const workspace = await this.findPublicByDomain(domain);
    return { authorized: true, domain: workspace.customDomain };
  }

  async update(workspaceId: string, dto: UpdateWorkspaceDto, userId: string) {
    await this.assertAccess(workspaceId, userId, MANAGER_ROLES);
    const { brand, slug: requestedSlug, customDomain: requestedDomain, ...workspaceData } = dto;
    const data: Prisma.WorkspaceUpdateInput = { ...workspaceData };

    if (requestedSlug) data.slug = await this.generateUniqueSlug(requestedSlug, workspaceId);
    if (requestedDomain !== undefined) {
      const current = await this.prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: { customDomain: true },
      });
      const customDomain = requestedDomain ? this.normalizeCustomDomain(requestedDomain) : null;
      if (customDomain) await this.assertDomainAvailable(customDomain, workspaceId);
      data.customDomain = customDomain;
      if (customDomain !== current?.customDomain) {
        data.customDomainVerifiedAt = null;
        data.customDomainVerificationToken = customDomain ? randomBytes(18).toString('hex') : null;
      }
    }

    return this.prisma.$transaction(async tx => {
      if (brand) {
        const brandData = brand as Prisma.InputJsonObject;
        await tx.brandTheme.upsert({
          where: { workspaceId },
          update: brand as any,
          create: { workspace: { connect: { id: workspaceId } }, ...(brandData as any) },
        });
      }
      return tx.workspace.update({
        where: { id: workspaceId },
        data,
        include: this.workspaceInclude(),
      });
    });
  }

  async updateBrand(workspaceId: string, dto: UpdateBrandThemeDto, userId: string) {
    await this.assertAccess(workspaceId, userId, MANAGER_ROLES);
    const data = { ...dto, settings: dto.settings as Prisma.InputJsonValue };
    return this.prisma.brandTheme.upsert({
      where: { workspaceId },
      update: data,
      create: { workspace: { connect: { id: workspaceId } }, ...data },
    });
  }

  async verifyCustomDomain(workspaceId: string, userId: string) {
    await this.assertAccess(workspaceId, userId, [WorkspaceRole.OWNER, WorkspaceRole.ADMIN]);
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { customDomain: true, customDomainVerificationToken: true },
    });
    if (!workspace?.customDomain || !workspace.customDomainVerificationToken) {
      throw new BadRequestException('Configura un dominio antes de verificarlo');
    }

    let records: string[][];
    try {
      records = await resolveTxt(`_lucilamon.${workspace.customDomain}`);
    } catch {
      throw new BadRequestException('No encontramos el registro TXT de verificación');
    }
    const expected = `lucilamon-verification=${workspace.customDomainVerificationToken}`;
    if (!records.some(parts => parts.join('') === expected)) {
      throw new BadRequestException('El registro TXT todavía no coincide con el token del espacio');
    }
    return this.prisma.workspace.update({
      where: { id: workspaceId },
      data: { customDomainVerifiedAt: new Date() },
      select: { customDomain: true, customDomainVerifiedAt: true },
    });
  }

  async addMember(workspaceId: string, dto: AddWorkspaceMemberDto, userId: string) {
    await this.assertAccess(workspaceId, userId, [WorkspaceRole.OWNER, WorkspaceRole.ADMIN]);
    if (dto.role === 'OWNER') throw new BadRequestException('La propiedad se transfiere mediante un proceso separado');

    const user = await this.prisma.user.findUnique({ where: { email: dto.email.toLowerCase() } });
    if (!user) throw new NotFoundException('El usuario debe registrarse antes de ser añadido al equipo');

    return this.prisma.workspaceMember.upsert({
      where: { workspaceId_userId: { workspaceId, userId: user.id } },
      update: { role: dto.role, status: 'ACTIVE' },
      create: { workspaceId, userId: user.id, role: dto.role },
      include: { user: { select: { id: true, name: true, email: true, profileImageUrl: true } } },
    });
  }

  async updateMember(workspaceId: string, memberId: string, dto: UpdateWorkspaceMemberDto, userId: string) {
    await this.assertAccess(workspaceId, userId, [WorkspaceRole.OWNER, WorkspaceRole.ADMIN]);
    if (dto.role === WorkspaceRole.OWNER) {
      throw new BadRequestException('La propiedad se transfiere mediante un proceso separado');
    }
    if (dto.role === undefined && dto.status === undefined) {
      throw new BadRequestException('Indica el rol o el estado que deseas cambiar');
    }
    const member = await this.prisma.workspaceMember.findFirst({
      where: { id: memberId, workspaceId },
      select: { id: true, userId: true, role: true },
    });
    if (!member) throw new NotFoundException('Miembro no encontrado');
    if (member.role === WorkspaceRole.OWNER) {
      throw new BadRequestException('No puedes modificar al propietario desde el equipo');
    }
    if (member.userId === userId && dto.status === 'SUSPENDED') {
      throw new BadRequestException('No puedes suspender tu propio acceso');
    }
    return this.prisma.workspaceMember.update({
      where: { id: member.id },
      data: { role: dto.role, status: dto.status },
      include: { user: { select: { id: true, name: true, email: true, profileImageUrl: true } } },
    });
  }

  async assertAccess(workspaceId: string, userId: string, roles?: WorkspaceRole[]) {
    const membership = await this.prisma.workspaceMember.findFirst({
      where: { workspaceId, userId, status: 'ACTIVE' },
      include: { workspace: { select: { deletedAt: true } } },
    });
    if (!membership || membership.workspace.deletedAt) {
      throw new ForbiddenException('No tienes acceso a este espacio');
    }
    if (roles && !roles.includes(membership.role)) {
      throw new ForbiddenException('No tienes permisos suficientes en este espacio');
    }
    return membership;
  }

  private workspaceInclude(): Prisma.WorkspaceInclude {
    return {
      brandTheme: true,
      members: {
        include: { user: { select: { id: true, name: true, email: true, profileImageUrl: true } } },
      },
      _count: { select: { events: true, members: true, sponsors: true } },
      events: {
        where: { deletedAt: null },
        orderBy: { date: 'desc' },
        select: {
          id: true,
          name: true,
          slug: true,
          date: true,
          location: true,
          imageUrl: true,
          commerceMode: true,
          sponsorOverlayEnabled: true,
          isPublished: true,
          _count: { select: { photos: true } },
        },
      },
    };
  }

  private normalizeSlug(value: string) {
    return value
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'espacio';
  }

  private async generateUniqueSlug(value: string, excludeId?: string) {
    const base = this.normalizeSlug(value);
    let slug = base;
    let suffix = 2;
    while (await this.prisma.workspace.findFirst({ where: { slug, id: excludeId ? { not: excludeId } : undefined } })) {
      slug = `${base}-${suffix++}`;
    }
    return slug;
  }

  private async assertDomainAvailable(domain: string, excludeId?: string) {
    const existing = await this.prisma.workspace.findFirst({
      where: { customDomain: domain, id: excludeId ? { not: excludeId } : undefined },
      select: { id: true },
    });
    if (existing) throw new ConflictException('Este dominio ya está asociado a otro espacio');
  }

  private normalizeCustomDomain(value: string) {
    const domain = value.trim().toLowerCase().replace(/\.$/, '');
    if (
      domain.length > 253
      || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)
    ) {
      throw new BadRequestException('El dominio personalizado no es válido');
    }
    const reserved = new Set(
      this.config.get('PLATFORM_DOMAINS', 'lucilamon.com,www.lucilamon.com')
        .split(/[\s,]+/)
        .map(item => item.trim().toLowerCase())
        .filter(Boolean),
    );
    if (reserved.has(domain)) {
      throw new BadRequestException('Este dominio está reservado por la plataforma');
    }
    return domain;
  }
}
