import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, WorkspaceRole } from '@prisma/client';
import { PrismaService } from '../common/services/prisma.service';
import { EventsService } from '../events/events.service';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { CreateSponsorDto } from './dto/create-sponsor.dto';
import { AttachEventSponsorDto } from './dto/attach-event-sponsor.dto';
import { UserRole } from '@shared/types';
import { UpdateSponsorDto } from './dto/update-sponsor.dto';

@Injectable()
export class SponsorsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly workspaces: WorkspacesService,
    private readonly events: EventsService,
  ) {}

  async create(workspaceId: string, dto: CreateSponsorDto, userId: string) {
    await this.workspaces.assertAccess(workspaceId, userId, [WorkspaceRole.OWNER, WorkspaceRole.ADMIN, WorkspaceRole.EDITOR]);
    return this.prisma.sponsor.create({ data: { workspaceId, ...dto } });
  }

  async list(workspaceId: string, userId: string) {
    await this.workspaces.assertAccess(workspaceId, userId);
    return this.prisma.sponsor.findMany({
      where: { workspaceId },
      include: { events: { include: { event: { select: { id: true, name: true, slug: true } } } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async update(workspaceId: string, sponsorId: string, dto: UpdateSponsorDto, userId: string) {
    await this.workspaces.assertAccess(workspaceId, userId, [WorkspaceRole.OWNER, WorkspaceRole.ADMIN, WorkspaceRole.EDITOR]);
    const sponsor = await this.prisma.sponsor.findFirst({ where: { id: sponsorId, workspaceId } });
    if (!sponsor) throw new NotFoundException('Patrocinador no encontrado');
    return this.prisma.sponsor.update({ where: { id: sponsorId }, data: dto });
  }

  async attach(eventId: string, dto: AttachEventSponsorDto, userId: string, userRole: UserRole) {
    const event = await this.events.assertCanManageEvent(eventId, userId, userRole);
    const sponsor = await this.prisma.sponsor.findUnique({ where: { id: dto.sponsorId } });
    if (!sponsor) throw new NotFoundException('Patrocinador no encontrado');
    if (!event.workspaceId || sponsor.workspaceId !== event.workspaceId) {
      throw new BadRequestException('El patrocinador debe pertenecer al mismo espacio que el evento');
    }

    const placement = (dto.placement || { position: 'bottom', opacity: 0.92, maxHeightPercent: 8 }) as Prisma.InputJsonObject;
    const result = await this.prisma.eventSponsor.upsert({
      where: { eventId_sponsorId: { eventId, sponsorId: dto.sponsorId } },
      update: {
        status: 'ACTIVE',
        priority: dto.priority ?? 0,
        requiredOnFreeDownloads: dto.requiredOnFreeDownloads ?? true,
        placement,
      },
      create: {
        eventId,
        sponsorId: dto.sponsorId,
        priority: dto.priority ?? 0,
        requiredOnFreeDownloads: dto.requiredOnFreeDownloads ?? true,
        placement,
      },
      include: { sponsor: true },
    });
    await this.prisma.event.update({ where: { id: eventId }, data: { sponsorOverlayEnabled: true } });
    return result;
  }

  async detach(eventId: string, sponsorId: string, userId: string, userRole: UserRole) {
    await this.events.assertCanManageEvent(eventId, userId, userRole);
    const attached = await this.prisma.eventSponsor.findUnique({ where: { eventId_sponsorId: { eventId, sponsorId } } });
    if (!attached) throw new NotFoundException('El patrocinador no está asociado al evento');
    await this.prisma.eventSponsor.delete({ where: { id: attached.id } });
    const remaining = await this.prisma.eventSponsor.count({ where: { eventId, status: 'ACTIVE' } });
    if (remaining === 0) {
      await this.prisma.event.update({ where: { id: eventId }, data: { sponsorOverlayEnabled: false } });
    }
    return { detached: true };
  }
}
