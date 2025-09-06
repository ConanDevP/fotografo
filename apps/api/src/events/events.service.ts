import { Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../common/services/prisma.service';
import { CloudinaryService } from '../common/services/cloudinary.service';
import { CreateEventDto } from './dto/create-event.dto';
import { UpdateEventDto } from './dto/update-event.dto';
import { UserRole } from '@shared/types';
import { ERROR_CODES } from '@shared/constants';

@Injectable()
export class EventsService {
  constructor(
    private prisma: PrismaService,
    private cloudinaryService: CloudinaryService,
  ) {}

  async create(createEventDto: CreateEventDto, userId: string) {
    const { name, date, location, bibRules, pricing } = createEventDto;
    
    // Generate unique slug from name
    const baseSlug = this.generateSlug(name);
    const slug = await this.generateUniqueSlug(baseSlug);

    return this.prisma.event.create({
      data: {
        name,
        slug,
        date: new Date(date),
        location,
        bibRules: bibRules as any,
        pricing: pricing as any,
        ownerId: userId,
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
  }

  async findAll(page = 1, limit = 20) {
    const skip = (page - 1) * limit;

    const [events, total] = await Promise.all([
      this.prisma.event.findMany({
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          owner: {
            select: { id: true, email: true, role: true },
          },
          _count: {
            select: { photos: true },
          },
        },
      }),
      this.prisma.event.count(),
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
    const event = await this.prisma.event.findUnique({
      where: { id },
      include: {
        owner: {
          select: { id: true, email: true, role: true },
        },
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

  async findBySlug(slug: string) {
    const event = await this.prisma.event.findUnique({
      where: { slug },
      include: {
        owner: {
          select: { id: true, email: true, role: true },
        },
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

  async update(id: string, updateEventDto: UpdateEventDto, userId: string, userRole: UserRole) {
    const event = await this.findOne(id);

    // Check permissions
    if (userRole !== UserRole.ADMIN && event.ownerId !== userId) {
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'No tienes permisos para editar este evento',
      });
    }

    const updateData: any = { ...updateEventDto };
    
    if (updateEventDto.date) {
      updateData.date = new Date(updateEventDto.date);
    }

    // If name is being updated, regenerate slug
    if (updateEventDto.name && updateEventDto.name !== event.name) {
      const baseSlug = this.generateSlug(updateEventDto.name);
      updateData.slug = await this.generateUniqueSlug(baseSlug, id);
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

  async remove(id: string, userId: string, userRole: UserRole) {
    const event = await this.findOne(id);

    // Check permissions
    if (userRole !== UserRole.ADMIN && event.ownerId !== userId) {
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'No tienes permisos para eliminar este evento',
      });
    }

    // Check if event has photos
    const photoCount = await this.prisma.photo.count({
      where: { eventId: id },
    });

    if (photoCount > 0) {
      throw new BadRequestException({
        code: ERROR_CODES.VALIDATION_ERROR,
        message: 'No se puede eliminar un evento que tiene fotos',
      });
    }

    return this.prisma.event.delete({
      where: { id },
    });
  }

  async getEventPhotos(
    eventId: string,
    userId: string,
    userRole: UserRole,
    page = 1,
    limit = 50,
    status?: 'PENDING' | 'PROCESSED' | 'FAILED'
  ) {
    // Verify event exists and user has permissions
    const event = await this.findOne(eventId);
    
    if (userRole !== UserRole.ADMIN && event.ownerId !== userId) {
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'No tienes permisos para ver las fotos de este evento',
      });
    }

    const skip = (page - 1) * limit;

    // Build filters
    const where: any = { eventId };
    if (status) {
      where.status = status;
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
              bib: true,
              confidence: true,
              bbox: true,
              source: true,
            },
            orderBy: { confidence: 'desc' },
          },
          _count: {
            select: { bibs: true },
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
        cloudinaryId: photo.cloudinaryId,
        originalUrl: photo.originalUrl,
        thumbUrl: photo.thumbUrl,
        watermarkUrl: photo.watermarkUrl,
        width: photo.width,
        height: photo.height,
        status: photo.status,
        takenAt: photo.takenAt,
        createdAt: photo.createdAt,
        photographer: photo.photographer,
        detectedBibs: photo.bibs,
        bibCount: photo._count.bibs,
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
      const existing = await this.prisma.event.findUnique({
        where: { slug },
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

  async uploadEventImage(
    eventId: string, 
    file: Express.Multer.File, 
    userId: string, 
    userRole: UserRole
  ) {
    const event = await this.findOne(eventId);
    
    // Check permissions
    if (userRole !== UserRole.ADMIN && event.ownerId !== userId) {
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'No tienes permisos para subir imagen a este evento',
      });
    }

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

    try {
      // Remove old image if exists
      if (event.imageUrl) {
        await this.cloudinaryService.deleteImage(this.extractCloudinaryIdFromUrl(event.imageUrl));
      }

      // Upload new image
      const uploadResult = await this.cloudinaryService.uploadImage(
        file.buffer,
        `events/${eventId}/cover/event-cover`,
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
    
    // Check permissions
    if (userRole !== UserRole.ADMIN && event.ownerId !== userId) {
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'No tienes permisos para eliminar la imagen de este evento',
      });
    }

    if (!event.imageUrl) {
      throw new BadRequestException('El evento no tiene imagen para eliminar');
    }

    try {
      // Delete from Cloudinary
      await this.cloudinaryService.deleteImage(this.extractCloudinaryIdFromUrl(event.imageUrl));

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

  private extractCloudinaryIdFromUrl(url: string): string {
    // Extract public_id from Cloudinary URL
    // Example: https://res.cloudinary.com/demo/image/upload/v1234567890/events/event-id/cover/event-cover.jpg
    const matches = url.match(/\/([^\/]+\/[^\/]+\/[^\/]+\/[^\.]+)/);
    return matches ? matches[1] : url.split('/').pop()?.split('.')[0] || '';
  }
}