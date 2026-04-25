import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/services/prisma.service';
import { CloudinaryService } from '../common/services/cloudinary.service';
import { PhotoStatus, UserRole } from '@shared/types';

interface RandomPhotoRow {
  id: string;
  watermark_url: string;
  thumb_url: string | null;
  taken_at: Date | null;
  event_id: string;
  event_name: string;
  event_location: string | null;
}

@Injectable()
export class PublicService {
  constructor(
    private prisma: PrismaService,
    private cloudinaryService: CloudinaryService,
  ) {}

  async getEventPhotosWithWatermark(eventId: string, page: number = 1, limit: number = 50) {
    const event = await this.prisma.event.findUnique({
      where: { id: eventId, deletedAt: null },
    });

    if (!event) {
      throw new NotFoundException('Evento no encontrado');
    }

    const skip = (page - 1) * limit;

    const [photos, total] = await Promise.all([
      this.prisma.photo.findMany({
        where: {
          eventId,
          status: PhotoStatus.PROCESSED,
        },
        include: {
          bibs: true,
          photographer: {
            select: {
              id: true,
              email: true,
            },
          },
        },
        orderBy: {
          takenAt: 'desc',
        },
        skip,
        take: limit,
      }),
      this.prisma.photo.count({
        where: {
          eventId,
          status: PhotoStatus.PROCESSED,
        },
      }),
    ]);

    const items = photos.map(photo => ({
      id: photo.id,
      eventId: photo.eventId,
      watermarkUrl: photo.watermarkUrl,
      thumbUrl: photo.thumbUrl,
      width: photo.width,
      height: photo.height,
      takenAt: photo.takenAt,
      createdAt: photo.createdAt,
      photographer: photo.photographer,
      detectedBibs: photo.bibs.map(bib => ({
        bib: bib.bib,
        confidence: bib.confidence,
        source: bib.source,
      })),
      bibCount: photo.bibs.length,
    }));

    const pages = Math.ceil(total / limit);

    return {
      items,
      pagination: { page, limit, total, pages },
      total,
    };
  }

  async searchPhotosByBibWithWatermark(
    eventId: string,
    bib: string,
    page: number = 1,
    limit: number = 20
  ) {
    const event = await this.prisma.event.findUnique({
      where: { id: eventId, deletedAt: null },
    });

    if (!event) {
      throw new NotFoundException('Evento no encontrado');
    }

    const skip = (page - 1) * limit;

    const [photos, total] = await Promise.all([
      this.prisma.photo.findMany({
        where: {
          eventId,
          status: PhotoStatus.PROCESSED,
          bibs: { some: { bib } },
        },
        include: {
          bibs: { where: { bib } },
          photographer: {
            select: { id: true, email: true },
          },
        },
        orderBy: { takenAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.photo.count({
        where: {
          eventId,
          status: PhotoStatus.PROCESSED,
          bibs: { some: { bib } },
        },
      }),
    ]);

    const items = photos.map(photo => ({
      id: photo.id,
      eventId: photo.eventId,
      watermarkUrl: photo.watermarkUrl,
      thumbUrl: photo.thumbUrl,
      width: photo.width,
      height: photo.height,
      takenAt: photo.takenAt,
      createdAt: photo.createdAt,
      photographer: photo.photographer,
      detectedBibs: photo.bibs.map(detectedBib => ({
        bib: detectedBib.bib,
        confidence: detectedBib.confidence,
        source: detectedBib.source,
      })),
      bibCount: photo.bibs.length,
    }));

    const pages = Math.ceil(total / limit);

    return {
      items,
      pagination: { page, limit, total, pages },
      total,
    };
  }

  async getEventPublic(eventId: string) {
    const event = await this.prisma.event.findUnique({
      where: { id: eventId, deletedAt: null },
      include: {
        owner: {
          select: { id: true, email: true, role: true },
        },
        _count: {
          select: {
            photos: { where: { status: PhotoStatus.PROCESSED } },
          },
        },
      },
    });

    if (!event) {
      throw new NotFoundException('Evento no encontrado');
    }

    return {
      id: event.id,
      name: event.name,
      slug: event.slug,
      date: event.date,
      location: event.location,
      imageUrl: event.imageUrl,
      owner: event.owner,
      photoCount: event._count.photos,
      createdAt: event.createdAt,
    };
  }

  async getEventsPublic(page: number = 1, limit: number = 20) {
    const skip = (page - 1) * limit;

    const [events, total] = await Promise.all([
      this.prisma.event.findMany({
        where: { deletedAt: null },
        include: {
          owner: {
            select: { id: true, email: true, role: true },
          },
          _count: {
            select: {
              photos: { where: { status: PhotoStatus.PROCESSED } },
            },
          },
        },
        orderBy: { date: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.event.count({ where: { deletedAt: null } }),
    ]);

    const items = events.map(event => ({
      id: event.id,
      name: event.name,
      slug: event.slug,
      date: event.date,
      location: event.location,
      imageUrl: event.imageUrl,
      owner: event.owner,
      photoCount: event._count.photos,
      createdAt: event.createdAt,
    }));

    const pages = Math.ceil(total / limit);

    return {
      items,
      pagination: { page, limit, total, pages },
    };
  }

  // Returns N random processed photos from non-deleted events (for landing page carousel)
  async getRandomPhotos(limit: number = 20) {
    const safeLimit = Math.min(Math.max(1, limit), 50);

    const rows = await this.prisma.$queryRaw<RandomPhotoRow[]>`
      SELECT
        p.id,
        p.watermark_url,
        p.thumb_url,
        p.taken_at,
        p.event_id,
        e.name   AS event_name,
        e.location AS event_location
      FROM photos p
      INNER JOIN events e ON p.event_id = e.id
      WHERE p.status = 'PROCESSED'
        AND p.watermark_url IS NOT NULL
        AND e.deleted_at IS NULL
      ORDER BY RANDOM()
      LIMIT ${safeLimit}
    `;

    return rows.map(r => ({
      id: r.id,
      watermarkUrl: r.watermark_url,
      thumbUrl: r.thumb_url,
      takenAt: r.taken_at,
      eventId: r.event_id,
      eventName: r.event_name,
      eventLocation: r.event_location,
    }));
  }

  // Real platform stats for the landing page
  async getPublicStats() {
    const [photoCount, eventCount, photographerCount, athleteCount] = await Promise.all([
      this.prisma.photo.count({ where: { status: PhotoStatus.PROCESSED } }),
      this.prisma.event.count({ where: { deletedAt: null } }),
      this.prisma.user.count({ where: { role: UserRole.PHOTOGRAPHER } }),
      this.prisma.user.count({ where: { role: UserRole.ATHLETE } }),
    ]);

    return {
      photos: photoCount,
      events: eventCount,
      photographers: photographerCount,
      athletes: athleteCount,
    };
  }
}
