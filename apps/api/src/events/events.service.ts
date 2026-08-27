import { Injectable, NotFoundException, ForbiddenException, BadRequestException, Logger } from '@nestjs/common';
import { PrismaService } from '../common/services/prisma.service';
import { StorageService } from '../common/services/storage.service';
import { CreateEventDto } from './dto/create-event.dto';
import { UpdateEventDto } from './dto/update-event.dto';
import { UserRole } from '@shared/types';
import { ERROR_CODES } from '@shared/constants';
import { createHash, randomBytes } from 'crypto';
import { EventContributorRole, WorkspaceRole } from '@prisma/client';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { BillingService } from '../billing/billing.service';
import { InviteContributorDto } from './dto/invite-contributor.dto';
import { ReviewPhotoDto } from './dto/review-photo.dto';
import { QueueService } from '../common/services/queue.service';

@Injectable()
export class EventsService {
  private readonly logger = new Logger(EventsService.name);

  constructor(
    private prisma: PrismaService,
    private storageService: StorageService,
    private workspacesService: WorkspacesService,
    private queueService: QueueService,
    private billingService: BillingService,
  ) {}

  async create(createEventDto: CreateEventDto, userId: string) {
    const {
      name,
      date,
      location,
      bibRules,
      pricing,
      commerceMode,
      organizerCommissionPercent,
      sponsorOverlayEnabled,
      requiresPhotoApproval,
      isPublished,
    } = createEventDto;

    this.validateBibConfiguration(bibRules);
    this.validatePricing(pricing);
    this.assertPublishableCommerce(isPublished ?? false, commerceMode || 'PAID', pricing);

    const workspace = createEventDto.workspaceId
      ? await this.workspacesService.assertAccess(
          createEventDto.workspaceId,
          userId,
          [WorkspaceRole.OWNER, WorkspaceRole.ADMIN, WorkspaceRole.EDITOR],
        ).then(() => this.prisma.workspace.findUnique({ where: { id: createEventDto.workspaceId } }))
      : await this.prisma.workspace.findFirst({
          where: { members: { some: { userId, status: 'ACTIVE' } }, deletedAt: null },
          orderBy: { createdAt: 'asc' },
        });

    if (!workspace) {
      throw new BadRequestException('Crea un espacio de fotógrafo u organizador antes de crear eventos');
    }
    
    // Generate unique slug from name with timestamp to ensure uniqueness
    const baseSlug = this.generateSlug(name);
    const timestamp = Date.now();
    const slug = `${baseSlug}-${timestamp}`;

    const created = await this.prisma.event.create({
      data: {
        name,
        slug,
        date: new Date(date),
        location,
        bibRules: bibRules as any,
        pricing: pricing as any,
        ownerId: userId,
        workspaceId: workspace.id,
        commerceMode,
        organizerCommissionPercent,
        sponsorOverlayEnabled,
        requiresPhotoApproval,
        isPublished: isPublished ?? false,
        publishedAt: isPublished ? new Date() : null,
        isFreeDownload: commerceMode === 'FREE',
      },
      include: {
        owner: {
          select: { id: true, email: true, role: true },
        },
        _count: {
          select: { photos: true },
        },
      },
    });

    // Un evento nuevo se publica sin fotografías, así que el importe es cero y
    // esto solo deja constancia de que ya se liquidó. Las que se suban después
    // se acumulan para la factura del mes.
    if (created.isPublished && this.billingService.isShareMode(created.commerceMode)) {
      await this.billingService.chargePublication(created.id);
    }

    return created;
  }

  async findAll(page = 1, limit = 20) {
    page = Number.isFinite(page) ? Math.max(1, page) : 1;
    limit = Number.isFinite(limit) ? Math.min(100, Math.max(1, limit)) : 20;
    const skip = (page - 1) * limit;

    const [events, total] = await Promise.all([
      this.prisma.event.findMany({
        where: { deletedAt: null, isPublished: true },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          owner: {
            select: { id: true, role: true },
          },
          _count: { select: { photos: { where: { status: 'PROCESSED', publicationStatus: 'APPROVED' } } } },
        },
      }),
      this.prisma.event.count({
        where: { deletedAt: null, isPublished: true },
      }),
    ]);

    return {
      items: events,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }

  async getPhotographerEvents(userId: string, userRole: UserRole, page = 1, limit = 20) {
    page = Number.isFinite(page) ? Math.max(1, page) : 1;
    limit = Number.isFinite(limit) ? Math.min(100, Math.max(1, limit)) : 20;
    const skip = (page - 1) * limit;
    
    // Los admins pueden ver todos los eventos, los fotógrafos solo los suyos
    // Siempre excluir eventos eliminados
    const whereClause = userRole === UserRole.ADMIN
      ? { deletedAt: null }
      : {
          deletedAt: null,
          OR: [
            { ownerId: userId },
            { workspace: { members: { some: { userId, status: 'ACTIVE' as const } } } },
            { contributors: { some: { userId, status: 'ACCEPTED' as const } } },
          ],
        };

    const [events, total] = await Promise.all([
      this.prisma.event.findMany({
        where: whereClause,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          owner: {
            select: { id: true, email: true, role: true },
          },
          _count: {
            select: { 
              photos: true,
              photoBibs: true,
              bibSubscriptions: true,
              orders: true,
            },
          },
        },
      }),
      this.prisma.event.count({
        where: whereClause,
      }),
    ]);

    return {
      items: events,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }

  async findOne(id: string) {
    const event = await this.prisma.event.findFirst({
      where: { id, deletedAt: null }, // Solo eventos no eliminados
      include: {
        owner: {
          select: { id: true, email: true, role: true },
        },
        workspace: { include: { brandTheme: true } },
        _count: {
          select: { 
            photos: true,
            photoBibs: true,
            bibSubscriptions: true,
          },
        },
      },
    });

    if (!event) {
      throw new NotFoundException({
        code: ERROR_CODES.EVENT_NOT_FOUND,
        message: 'Evento no encontrado',
      });
    }

    return event;
  }

  async findOneForUser(id: string, userId: string, userRole: UserRole) {
    await this.assertCanAccessEvent(id, userId, userRole);
    return this.findOne(id);
  }

  async findBySlug(slug: string) {
    const event = await this.prisma.event.findFirst({
      where: { slug, deletedAt: null, isPublished: true },
      include: {
        owner: {
          select: { id: true, role: true },
        },
        _count: {
          select: {
            photos: { where: { status: 'PROCESSED', publicationStatus: 'APPROVED' } },
            photoBibs: true,
          },
        },
      },
    });

    if (!event) {
      throw new NotFoundException({
        code: ERROR_CODES.EVENT_NOT_FOUND,
        message: 'Evento no encontrado',
      });
    }

    return event;
  }

  async update(id: string, updateEventDto: UpdateEventDto, userId: string, userRole: UserRole) {
    const event = await this.findOne(id);

    await this.assertCanManageEvent(id, userId, userRole);

    const nextPricing = updateEventDto.pricing === undefined ? event.pricing : updateEventDto.pricing;
    const nextBibRules = updateEventDto.bibRules === undefined ? event.bibRules : updateEventDto.bibRules;
    const nextCommerceMode = updateEventDto.commerceMode || event.commerceMode;
    const nextPublished = updateEventDto.isPublished ?? event.isPublished;
    this.validateBibConfiguration(nextBibRules);
    this.validatePricing(nextPricing);
    this.assertPublishableCommerce(nextPublished, nextCommerceMode, nextPricing);

    const updateData: any = { ...updateEventDto };
    
    if (updateEventDto.date) {
      updateData.date = new Date(updateEventDto.date);
    }

    // If name is being updated, regenerate slug
    if (updateEventDto.name && updateEventDto.name !== event.name) {
      const baseSlug = this.generateSlug(updateEventDto.name);
      updateData.slug = await this.generateUniqueSlug(baseSlug, id);
    }

    if (updateEventDto.isPublished !== undefined) {
      updateData.publishedAt = updateEventDto.isPublished ? event.publishedAt || new Date() : null;
    }
    if (updateEventDto.commerceMode) {
      updateData.isFreeDownload = updateEventDto.commerceMode === 'FREE';
    }

    // El modo compartir se cobra al publicar, que es cuando nace la obligación:
    // hasta entonces el fotógrafo puede subir, revisar y descartar sin pagar.
    // Se cobra antes de escribir para que un fallo de cobro no deje el evento
    // publicado sin haberlo pagado.
    const publishingNow = nextPublished && !event.isPublished;
    if (publishingNow && this.billingService.isShareMode(nextCommerceMode)) {
      await this.billingService.chargePublication(id);
    }

    return this.prisma.event.update({
      where: { id },
      data: updateData,
      include: {
        owner: {
          select: { id: true, email: true, role: true },
        },
        _count: {
          select: { photos: true },
        },
      },
    });
  }

  /**
   * Borra un evento de verdad: sus fotografías, sus objetos en almacenamiento y
   * el espacio que ocupaban.
   *
   * Antes solo marcaba `deletedAt`. Un evento "eliminado" seguía consumiendo la
   * cuota del fotógrafo para siempre y sus ficheros se seguían pagando en
   * Cloudflare sin que nadie pudiera verlos.
   *
   * No se permite si alguien ya compró fotografías. `order_items` apunta a
   * `photos` con ON DELETE SET NULL: borrarlas dejaría el pedido en pie pero sin
   * nada que descargar, y quien pagó se quedaría sin lo suyo. Para retirarlo de
   * la vista está despublicarlo, que no destruye nada.
   */
  async remove(id: string, userId: string, userRole: UserRole) {
    const event = await this.findOne(id);
    await this.assertCanManageEvent(id, userId, userRole);

    const paidOrders = await this.prisma.order.count({
      where: { eventId: id, status: { in: ['PAID', 'REFUNDED', 'DISPUTED'] } },
    });
    if (paidOrders > 0) {
      throw new BadRequestException({
        code: ERROR_CODES.VALIDATION_ERROR,
        message:
          `Este evento tiene ${paidOrders} compra(s) y no puede eliminarse: ` +
          'quien pagó perdería sus fotografías. Despublícalo para que deje de ser visible.',
      });
    }

    // Cuánto le devuelve a cada espacio. En un evento con colaboradores las
    // fotografías pertenecen a varios, y cada uno recupera solo lo suyo.
    const usage = await this.prisma.photo.groupBy({
      by: ['photographerWorkspaceId'],
      where: { eventId: id },
      _sum: { originalBytes: true, derivedBytes: true },
    });

    await this.prisma.$transaction(
      async tx => {
        // Las fotografías se borran explícitamente: la clave ajena de `photos`
        // hacia `events` es RESTRICT, así que borrar el evento sin ellas falla.
        await tx.photo.deleteMany({ where: { eventId: id } });
        await tx.event.delete({ where: { id } });

        // Dentro de la transacción para que el medidor no pueda quedarse
        // inflado si algo falla a mitad.
        for (const row of usage) {
          await this.billingService.releaseStorage(
            row.photographerWorkspaceId,
            (row._sum.originalBytes ?? 0) + (row._sum.derivedBytes ?? 0),
            tx,
          );
        }
      },
      // Un evento grande son miles de filas con sus cascadas; los 5 s por
      // defecto de Prisma se quedan cortos.
      { timeout: 120_000, maxWait: 10_000 },
    );

    // La base ya está limpia. Si el barrido del almacenamiento falla, queda
    // anotado para repasarlo, pero no se le devuelve un error al fotógrafo por
    // algo que ya está hecho.
    const objects = await this.storageService.deleteEventObjects(id);
    if (objects.failed > 0) {
      await this.prisma.auditLog
        .create({
          data: {
            userId,
            action: 'EVENT_STORAGE_CLEANUP_REQUIRED',
            data: { eventId: id, eventName: event.name, failed: objects.failed },
          },
        })
        .catch(() => undefined);
    }

    this.logger.log(
      `Evento ${id} eliminado: ${objects.deleted} objeto(s) borrado(s) del almacenamiento`,
    );

    return { message: 'Evento eliminado', deletedObjects: objects.deleted };
  }

  async restore(id: string, userId: string, userRole: UserRole) {
    // Solo admins pueden restaurar eventos
    if (userRole !== UserRole.ADMIN) {
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'Solo administradores pueden restaurar eventos',
      });
    }

    const event = await this.prisma.event.findFirst({
      where: { id, deletedAt: { not: null } }, // Solo eventos eliminados
    });

    if (!event) {
      throw new NotFoundException({
        code: ERROR_CODES.EVENT_NOT_FOUND,
        message: 'Evento eliminado no encontrado',
      });
    }

    return this.prisma.event.update({
      where: { id },
      data: { 
        deletedAt: null 
      },
    });
  }

  async getEventPhotos(
    eventId: string,
    userId: string,
    userRole: UserRole,
    page = 1,
    limit = 50,
    status?: 'PENDING' | 'PROCESSED' | 'FAILED',
    publicationStatus?: 'PENDING_REVIEW' | 'APPROVED' | 'REJECTED',
  ) {
    // Verify event exists and user has permissions
    await this.findOne(eventId);
    await this.assertCanAccessEvent(eventId, userId, userRole);

    if (status && !['PENDING', 'PROCESSED', 'FAILED'].includes(status)) {
      throw new BadRequestException('Estado de procesamiento inválido');
    }
    if (publicationStatus && !['PENDING_REVIEW', 'APPROVED', 'REJECTED'].includes(publicationStatus)) {
      throw new BadRequestException('Estado de publicación inválido');
    }

    page = Number.isFinite(page) ? Math.max(1, Math.floor(page)) : 1;
    limit = Number.isFinite(limit) ? Math.min(100, Math.max(1, Math.floor(limit))) : 50;
    const skip = (page - 1) * limit;

    // Build filters
    const where: any = { eventId };
    if (status) {
      where.status = status;
    }
    if (publicationStatus) {
      where.publicationStatus = publicationStatus;
    }

    const [photos, total, stats] = await Promise.all([
      this.prisma.photo.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          photographer: {
            select: { id: true, email: true },
          },
          bibs: {
            select: {
              id: true,
              bib: true,
              confidence: true,
              bbox: true,
              source: true,
            },
            orderBy: { confidence: 'desc' },
          },
          faces: {
            select: {
              id: true,
              confidence: true,
              bbox: true,
              age: true,
              gender: true,
            },
            orderBy: { confidence: 'desc' },
          },
          _count: {
            select: { 
              bibs: true,
              faces: true,
            },
          },
        },
      }),
      this.prisma.photo.count({ where }),
      // Get processing stats
      this.prisma.photo.groupBy({
        by: ['status'],
        where: { eventId },
        _count: { status: true },
      }),
    ]);

    // Format stats
    const processedStats = {
      total: 0,
      pending: 0,
      processed: 0,
      failed: 0,
    };

    stats.forEach(stat => {
      processedStats.total += stat._count.status;
      processedStats[stat.status.toLowerCase() as keyof typeof processedStats] = stat._count.status;
    });

    return {
      items: photos.map(photo => ({
        id: photo.id,
        thumbUrl: photo.thumbUrl,
        watermarkUrl: photo.watermarkUrl,
        width: photo.width,
        height: photo.height,
        status: photo.status,
        takenAt: photo.takenAt,
        createdAt: photo.createdAt,
        photographer: photo.photographer,
        detectedBibs: photo.bibs.map(bib => ({
          ...bib,
          id: bib.id.toString(),
          confidence: Number(bib.confidence),
        })),
        bibCount: photo._count.bibs,
        detectedFaces: photo.faces,
        faceCount: photo._count.faces,
      })),
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
      stats: processedStats,
    };
  }

  async validateBibRules(eventId: string, bib: string): Promise<boolean> {
    const event = await this.findOne(eventId);
    
    if (!event.bibRules) {
      return true; // No rules means all bibs are valid
    }

    const rules = event.bibRules as any;

    // Check if digits only
    if (rules.digitsOnly !== false && !/^[0-9]+$/.test(bib)) {
      return false;
    }

    // Check length constraints
    if (rules.minLen && bib.length < rules.minLen) {
      return false;
    }

    if (rules.maxLen && bib.length > rules.maxLen) {
      return false;
    }

    // Check regex pattern
    if (rules.regex) {
      const regex = new RegExp(rules.regex);
      if (!regex.test(bib)) {
        return false;
      }
    }

    // Check whitelist
    if (rules.whitelist && Array.isArray(rules.whitelist)) {
      if (!rules.whitelist.includes(bib)) {
        return false;
      }
    }

    // Check range
    if (rules.range && Array.isArray(rules.range) && rules.range.length === 2) {
      const bibNumber = parseInt(bib);
      if (isNaN(bibNumber) || bibNumber < rules.range[0] || bibNumber > rules.range[1]) {
        return false;
      }
    }

    return true;
  }

  private generateSlug(name: string): string {
    return name
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '') // Remove accents
      .replace(/[^a-z0-9\s-]/g, '') // Remove special characters
      .replace(/\s+/g, '-') // Replace spaces with hyphens
      .replace(/-+/g, '-') // Replace multiple hyphens
      .trim();
  }

  private async generateUniqueSlug(baseSlug: string, excludeId?: string): Promise<string> {
    let slug = baseSlug;
    let counter = 1;

    while (true) {
      const existing = await this.prisma.event.findFirst({
        where: { 
          slug,
          deletedAt: null
        },
        select: { id: true },
      });

      if (!existing || (excludeId && existing.id === excludeId)) {
        break;
      }

      slug = `${baseSlug}-${counter}`;
      counter++;
    }

    return slug;
  }

  private validatePricing(value: unknown) {
    if (value === undefined || value === null) return;
    if (typeof value !== 'object' || Array.isArray(value)) {
      throw new BadRequestException('La configuración de precios no es válida');
    }
    const pricing = value as Record<string, unknown>;
    for (const field of ['singlePhoto', 'pack5', 'pack10', 'allPhotos']) {
      const amount = pricing[field];
      if (!Number.isInteger(amount) || Number(amount) < 1 || Number(amount) > 100_000_000) {
        throw new BadRequestException(`El precio ${field} debe ser un entero positivo en centavos`);
      }
    }
    if (typeof pricing.currency !== 'string' || !/^[A-Z]{3}$/.test(pricing.currency.toUpperCase())) {
      throw new BadRequestException('La moneda debe usar un código ISO de tres letras');
    }
  }

  private validateBibConfiguration(value: unknown) {
    if (value === undefined || value === null) return;
    if (typeof value !== 'object' || Array.isArray(value)) {
      throw new BadRequestException('Las reglas de dorsal no son válidas');
    }
    const rules = value as Record<string, any>;
    if (rules.minLen && rules.maxLen && rules.minLen > rules.maxLen) {
      throw new BadRequestException('La longitud mínima del dorsal no puede superar la máxima');
    }
    if (rules.range && rules.range[0] > rules.range[1]) {
      throw new BadRequestException('El inicio del rango de dorsales no puede superar el final');
    }
    if (rules.regex) {
      const safeNumericPattern = /^(?:\^|\$|\\d|\[|\]|\{|\}|,|-|[0-9])+$/;
      if (typeof rules.regex !== 'string' || !safeNumericPattern.test(rules.regex)) {
        throw new BadRequestException('El patrón de dorsal solo puede usar dígitos, clases numéricas, anclas y cuantificadores acotados');
      }
      try {
        new RegExp(rules.regex);
      } catch {
        throw new BadRequestException('El patrón de dorsal no es una expresión válida');
      }
    }
  }

  private assertPublishableCommerce(isPublished: boolean, mode: string, pricing: unknown) {
    if (isPublished && mode === 'PAID' && !pricing) {
      throw new BadRequestException('Configura precios antes de publicar un evento con ventas');
    }
  }

  async uploadEventImage(
    eventId: string, 
    file: Express.Multer.File, 
    userId: string, 
    userRole: UserRole
  ) {
    const event = await this.findOne(eventId);
    
    await this.assertCanManageEvent(eventId, userId, userRole);

    // Validate file
    if (!file) {
      throw new BadRequestException('Se requiere un archivo de imagen');
    }

    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png'];
    if (!allowedTypes.includes(file.mimetype)) {
      throw new BadRequestException('Solo se permiten archivos JPG y PNG');
    }

    const maxSize = 5 * 1024 * 1024; // 5MB
    if (file.size > maxSize) {
      throw new BadRequestException('El archivo no puede superar los 5MB');
    }
    const isJpeg = file.buffer.length >= 3
      && file.buffer[0] === 0xff && file.buffer[1] === 0xd8 && file.buffer[2] === 0xff;
    const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    const isPng = file.buffer.length >= png.length && png.every((value, index) => file.buffer[index] === value);
    if (!isJpeg && !isPng) throw new BadRequestException('El contenido no corresponde a una imagen válida');

    try {
      const metadata = await this.storageService.getImageMetadata(file.buffer);
      if (!metadata.width || !metadata.height || metadata.width * metadata.height > 30_000_000) {
        throw new BadRequestException('La portada excede el límite de 30 megapíxeles');
      }
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new BadRequestException('No se pudieron validar las dimensiones de la portada');
    }

    try {
      const coverKey = `events/${eventId}/cover/event-cover`;
      // Remove old image if exists
      if (event.imageUrl) {
        try {
          await this.storageService.deleteImage(coverKey);
        } catch (error) {
          this.logger.warn(`No se pudo eliminar la portada anterior de ${eventId}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      // Upload new image
      const uploadResult = await this.storageService.uploadImage(
        file.buffer,
        coverKey,
        { width: 1200, height: 600, crop: 'fill' }
      );

      // Update event with new image URL
      const updatedEvent = await this.prisma.event.update({
        where: { id: eventId },
        data: { imageUrl: uploadResult.secure_url },
        include: {
          owner: {
            select: { id: true, email: true, role: true },
          },
          _count: {
            select: { photos: true },
          },
        },
      });

      return updatedEvent;
    } catch (error) {
      throw new BadRequestException({
        code: ERROR_CODES.UPLOAD_FAILED,
        message: 'Error al subir la imagen del evento',
        details: error instanceof Error ? error.message : 'Error desconocido',
      });
    }
  }

  async removeEventImage(eventId: string, userId: string, userRole: UserRole) {
    const event = await this.findOne(eventId);
    
    await this.assertCanManageEvent(eventId, userId, userRole);

    if (!event.imageUrl) {
      throw new BadRequestException('El evento no tiene imagen para eliminar');
    }

    try {
      // Delete from Cloudinary
      await this.storageService.deleteImage(`events/${eventId}/cover/event-cover`);

      // Update event removing image URL
      const updatedEvent = await this.prisma.event.update({
        where: { id: eventId },
        data: { imageUrl: null },
        include: {
          owner: {
            select: { id: true, email: true, role: true },
          },
          _count: {
            select: { photos: true },
          },
        },
      });

      return updatedEvent;
    } catch (error) {
      throw new BadRequestException({
        code: ERROR_CODES.UPLOAD_FAILED,
        message: 'Error al eliminar la imagen del evento',
        details: error instanceof Error ? error.message : 'Error desconocido',
      });
    }
  }

  async getLowConfidenceBibs(eventId: string, userId: string, userRole: UserRole, threshold = 0.8, page = 1, limit = 50) {
    // Verificar permisos primero
    await this.findOne(eventId);
    await this.assertCanAccessEvent(eventId, userId, userRole);

    threshold = Number.isFinite(threshold) ? Math.min(1, Math.max(0, threshold)) : 0.8;
    page = Number.isFinite(page) ? Math.max(1, Math.floor(page)) : 1;
    limit = Number.isFinite(limit) ? Math.min(100, Math.max(1, Math.floor(limit))) : 50;
    const skip = (page - 1) * limit;

    const [bibs, total] = await Promise.all([
      this.prisma.photoBib.findMany({
        where: {
          eventId,
          confidence: { lt: threshold },
          source: 'GEMINI', // Solo dorsales detectados por Gemini
        },
        skip,
        take: limit,
        orderBy: [
          { confidence: 'asc' }, // Los menos seguros primero
        ],
        include: {
          photo: {
            select: {
              id: true,
              thumbUrl: true,
              watermarkUrl: true,
              takenAt: true,
              width: true,
              height: true,
            },
          },
        },
      }),
      this.prisma.photoBib.count({
        where: {
          eventId,
          confidence: { lt: threshold },
          source: 'GEMINI',
        },
      }),
    ]);

    return {
      items: bibs.map(bib => ({
        id: bib.id.toString(), // Convertir BigInt a string
        photoId: bib.photoId,
        bib: bib.bib,
        confidence: Number(bib.confidence), // Convertir Decimal a number
        bbox: bib.bbox,
        source: bib.source,
        photo: bib.photo,
      })),
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
      threshold,
    };
  }

  async inviteContributor(eventId: string, dto: InviteContributorDto, invitedById: string, userRole: UserRole) {
    const event = await this.assertCanManageEvent(eventId, invitedById, userRole);
    const invitedEmail = dto.email.trim().toLowerCase();
    const user = await this.prisma.user.findUnique({ where: { email: invitedEmail } });
    const photographerWorkspace = user
      ? await this.prisma.workspace.findFirst({
          where: {
            ownerId: user.id,
            members: { some: { userId: user.id, status: 'ACTIVE', role: 'OWNER' } },
            deletedAt: null,
          },
          orderBy: { createdAt: 'asc' },
        })
      : null;

    const invitationToken = randomBytes(32).toString('hex');
    const tokenHash = this.hashToken(invitationToken);
    const data = {
      invitedEmail,
      userId: user?.id,
      photographerWorkspaceId: photographerWorkspace?.id,
      role: dto.role || EventContributorRole.PHOTOGRAPHER,
      organizerCommissionPercent: dto.organizerCommissionPercent ?? Number(event.organizerCommissionPercent),
      rightsTerms: dto.rightsTerms,
      tokenHash,
      invitedById,
      status: 'INVITED' as const,
      rightsAcceptedAt: null,
    };

    const invitation = await this.prisma.eventContributor.upsert({
      where: { eventId_invitedEmail: { eventId, invitedEmail } },
      update: data,
      create: { eventId, ...data },
    });

    const acceptanceUrlObject = new URL('/invitations/events', process.env.FRONTEND_URL || 'http://localhost:3000');
    acceptanceUrlObject.hash = new URLSearchParams({ token: invitationToken }).toString();
    const acceptanceUrl = acceptanceUrlObject.toString();
    try {
      await this.queueService.addSendEmailJob({
        kind: 'EVENT_INVITATION',
        eventId,
        eventName: event.name,
        workspaceName: event.workspace?.name || 'LucilaMon',
        email: invitedEmail,
        bib: '',
        acceptanceUrl,
        organizerCommissionPercent: Number(data.organizerCommissionPercent),
        rightsTerms: data.rightsTerms,
      });
    } catch {
      this.logger.warn(`La invitación ${invitation.id} fue creada, pero el correo quedó pendiente por indisponibilidad de la cola`);
    }

    const { tokenHash: _tokenHash, ...safeInvitation } = invitation;
    return {
      invitation: safeInvitation,
      invitationToken,
      acceptanceUrl,
    };
  }

  async listContributors(eventId: string, userId: string, userRole: UserRole) {
    await this.assertCanAccessEvent(eventId, userId, userRole);
    const contributors = await this.prisma.eventContributor.findMany({
      where: { eventId },
      include: {
        user: { select: { id: true, name: true, email: true, profileImageUrl: true } },
        photographerWorkspace: { select: { id: true, name: true, slug: true, logoUrl: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    return contributors.map(({ tokenHash: _tokenHash, ...contributor }) => contributor);
  }

  async getInvitation(token: string) {
    if (!/^[a-f0-9]{64}$/.test(token)) throw new NotFoundException('Invitación inválida o vencida');
    const invitation = await this.prisma.eventContributor.findUnique({
      where: { tokenHash: this.hashToken(token) },
      include: {
        event: { include: { workspace: { select: { id: true, name: true, slug: true, logoUrl: true } } } },
        invitedBy: { select: { id: true, name: true, email: true } },
      },
    });
    const expiresAt = invitation ? invitation.updatedAt.getTime() + 14 * 24 * 60 * 60 * 1000 : 0;
    if (!invitation || invitation.status !== 'INVITED' || expiresAt < Date.now()) {
      throw new NotFoundException('Invitación inválida o vencida');
    }
    const { tokenHash: _tokenHash, ...safeInvitation } = invitation;
    return safeInvitation;
  }

  async acceptInvitation(token: string, userId: string) {
    const invitation = await this.getInvitation(token);
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.email.toLowerCase() !== invitation.invitedEmail.toLowerCase()) {
      throw new ForbiddenException('Esta invitación pertenece a otra dirección de correo');
    }

    let workspace = await this.prisma.workspace.findFirst({
      where: {
        ownerId: userId,
        members: { some: { userId, status: 'ACTIVE', role: 'OWNER' } },
        deletedAt: null,
      },
      orderBy: { createdAt: 'asc' },
    });
    if (!workspace) workspace = await this.workspacesService.createDefaultForPhotographer(user);

    return this.prisma.eventContributor.update({
      where: { id: invitation.id },
      data: {
        userId,
        photographerWorkspaceId: workspace.id,
        status: 'ACCEPTED',
        rightsAcceptedAt: new Date(),
      },
      include: { event: true, photographerWorkspace: true },
    });
  }

  async revokeContributor(eventId: string, contributorId: string, userId: string, userRole: UserRole) {
    await this.assertCanManageEvent(eventId, userId, userRole);
    const contributor = await this.prisma.eventContributor.findFirst({ where: { id: contributorId, eventId } });
    if (!contributor) throw new NotFoundException('Colaborador no encontrado');
    return this.prisma.eventContributor.update({ where: { id: contributorId }, data: { status: 'REVOKED' } });
  }

  async reviewPhoto(eventId: string, photoId: string, dto: ReviewPhotoDto, userId: string, userRole: UserRole) {
    await this.assertCanManageEvent(eventId, userId, userRole);
    if (dto.status === 'PENDING_REVIEW') throw new BadRequestException('La revisión debe aprobar o rechazar la fotografía');
    const photo = await this.prisma.photo.findFirst({ where: { id: photoId, eventId } });
    if (!photo) throw new NotFoundException('Fotografía no encontrada');
    return this.prisma.photo.update({
      where: { id: photoId },
      data: {
        publicationStatus: dto.status,
        reviewNote: dto.note,
        reviewedAt: new Date(),
        reviewedById: userId,
      },
    });
  }

  async assertCanManageEvent(eventId: string, userId: string, userRole: UserRole) {
    const event = await this.prisma.event.findFirst({
      where: { id: eventId, deletedAt: null },
      include: {
        workspace: { include: { members: { where: { userId, status: 'ACTIVE' } } } },
        contributors: { where: { userId, status: 'ACCEPTED', role: { in: ['EDITOR', 'EVENT_MANAGER'] } } },
      },
    });
    if (!event) throw new NotFoundException('Evento no encontrado');
    const workspaceRole = event.workspace?.members[0]?.role;
    if (
      userRole !== UserRole.ADMIN &&
      event.ownerId !== userId &&
      !workspaceRole &&
      event.contributors.length === 0
    ) {
      throw new ForbiddenException('No tienes permisos para administrar este evento');
    }
    const managerRoles: WorkspaceRole[] = [WorkspaceRole.OWNER, WorkspaceRole.ADMIN, WorkspaceRole.EDITOR];
    if (workspaceRole && !managerRoles.includes(workspaceRole)) {
      throw new ForbiddenException('No tienes permisos para administrar este evento');
    }
    return event;
  }

  async assertCanAccessEvent(eventId: string, userId: string, userRole: UserRole) {
    const event = await this.prisma.event.findFirst({
      where: { id: eventId, deletedAt: null },
      include: {
        workspace: { include: { members: { where: { userId, status: 'ACTIVE' } } } },
        contributors: { where: { userId, status: 'ACCEPTED' } },
      },
    });
    if (!event) throw new NotFoundException('Evento no encontrado');
    if (userRole !== UserRole.ADMIN && event.ownerId !== userId && !event.workspace?.members.length && !event.contributors.length) {
      throw new ForbiddenException('No tienes acceso a este evento');
    }
    return event;
  }

  async assertCanManageAudienceData(eventId: string, userId: string, userRole: UserRole) {
    const allowedRoles: WorkspaceRole[] = [WorkspaceRole.OWNER, WorkspaceRole.ADMIN];
    const event = await this.prisma.event.findFirst({
      where: { id: eventId, deletedAt: null },
      include: {
        workspace: {
          include: {
            members: { where: { userId, status: 'ACTIVE', role: { in: allowedRoles } } },
          },
        },
      },
    });
    if (!event) throw new NotFoundException('Evento no encontrado');
    if (userRole !== UserRole.ADMIN && event.ownerId !== userId && !event.workspace?.members.length) {
      throw new ForbiddenException('No tienes permisos para consultar los datos de audiencia');
    }
    return event;
  }

  async assertCanUploadToEvent(eventId: string, userId: string, userRole: UserRole) {
    const uploadRoles: WorkspaceRole[] = [WorkspaceRole.OWNER, WorkspaceRole.ADMIN, WorkspaceRole.EDITOR, WorkspaceRole.PHOTOGRAPHER];
    const event = await this.prisma.event.findFirst({
      where: { id: eventId, deletedAt: null },
      include: {
        workspace: {
          include: {
            members: { where: { userId, status: 'ACTIVE', role: { in: uploadRoles } } },
          },
        },
        contributors: { where: { userId, status: 'ACCEPTED' } },
      },
    });
    if (!event) throw new NotFoundException('Evento no encontrado');
    if (
      userRole !== UserRole.ADMIN
      && event.ownerId !== userId
      && !event.workspace?.members.length
      && !event.contributors.length
    ) {
      throw new ForbiddenException('No tienes permisos para subir fotografías a este evento');
    }
    return event;
  }

  private hashToken(token: string) {
    return createHash('sha256').update(token).digest('hex');
  }
}
