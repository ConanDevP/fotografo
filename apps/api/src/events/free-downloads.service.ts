import { Injectable, Logger, BadRequestException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../common/services/prisma.service';
import { StorageService } from '../common/services/storage.service';
import { Request } from 'express';

interface FreeDownloadRequest {
  email?: string;
  name?: string;
  phone?: string;
  bibNumber?: string;
}

@Injectable()
export class FreeDownloadsService {
  private readonly logger = new Logger(FreeDownloadsService.name);

  constructor(
    private prisma: PrismaService,
    private storageService: StorageService,
  ) {}

  /**
   * Download a photo for free with user tracking
   */
  async downloadFreePhoto(
    eventId: string,
    photoId: string,
    userData: FreeDownloadRequest,
    req: Request,
  ): Promise<{ downloadUrl: string; expiresIn: number }> {
    // 1. Get event and verify it's free
    const event = await this.prisma.event.findUnique({
      where: { id: eventId },
      select: {
        id: true,
        isFreeDownload: true,
        freeDownloadUntil: true,
        requireEmailForFree: true,
        freeDownloadLimit: true,
      },
    });

    if (!event) {
      throw new BadRequestException('Evento no encontrado');
    }

    if (!event.isFreeDownload) {
      throw new ForbiddenException('Este evento no permite descargas gratuitas');
    }

    // 2. Check if free download period is still valid
    if (event.freeDownloadUntil && new Date() > event.freeDownloadUntil) {
      throw new BadRequestException('El período de descargas gratuitas ha expirado');
    }

    // 3. Verify email if required
    if (event.requireEmailForFree && !userData.email) {
      throw new BadRequestException('Email requerido para descargar');
    }

    // 4. Check download limit (by email or IP)
    if (event.freeDownloadLimit) {
      const identifier = userData.email || req.ip;
      const downloadCount = await this.prisma.freeDownload.count({
        where: {
          eventId,
          OR: [
            { email: userData.email || undefined },
            { ipAddress: req.ip },
          ],
        },
      });

      if (downloadCount >= event.freeDownloadLimit) {
        throw new BadRequestException(
          `Has alcanzado el límite de ${event.freeDownloadLimit} descargas gratuitas para este evento`
        );
      }
    }

    // 5. Get photo
    const photo = await this.prisma.photo.findUnique({
      where: { id: photoId },
      select: {
        id: true,
        originalUrl: true,
        eventId: true,
      },
    });

    if (!photo) {
      throw new BadRequestException('Foto no encontrada');
    }

    if (photo.eventId !== eventId) {
      throw new BadRequestException('La foto no pertenece a este evento');
    }

    // 6. Track download in analytics
    const referer = req.headers['referer'] || req.headers['referrer'];
    await this.prisma.freeDownload.create({
      data: {
        eventId,
        photoId,
        email: userData.email || null,
        name: userData.name || null,
        phone: userData.phone || null,
        bibNumber: userData.bibNumber || null,
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'] || null,
        referer: Array.isArray(referer) ? referer[0] : referer || null,
        // Note: For geolocation, you'd need to install geoip-lite or similar
        // country: geoip.lookup(req.ip)?.country,
        // city: geoip.lookup(req.ip)?.city,
      },
    });

    // 7. Increment event counter
    await this.prisma.event.update({
      where: { id: eventId },
      data: { totalFreeDownloads: { increment: 1 } },
    });

    this.logger.log(`Free download tracked: Event ${eventId}, Photo ${photoId}, Email: ${userData.email || 'N/A'}`);

    // 8. Generate presigned URL from R2 for download
    // Extract the R2 key from the originalUrl
    const urlObj = new URL(photo.originalUrl);
    const key = urlObj.pathname.startsWith('/') ? urlObj.pathname.substring(1) : urlObj.pathname;

    // Use StorageService to generate a secure download URL (15 minutes expiry)
    const downloadUrl = await this.storageService.generateSecureDownloadUrl(key, 900);

    return {
      downloadUrl,
      expiresIn: 900,
    };
  }

  /**
   * Get analytics for an event's free downloads
   */
  async getEventAnalytics(eventId: string) {
    const event = await this.prisma.event.findUnique({
      where: { id: eventId },
      select: {
        totalFreeDownloads: true,
        isFreeDownload: true,
      },
    });

    if (!event) {
      throw new BadRequestException('Evento no encontrado');
    }

    // Get all downloads for this event
    const downloads = await this.prisma.freeDownload.findMany({
      where: { eventId },
      select: {
        id: true,
        photoId: true,
        email: true,
        name: true,
        downloadedAt: true,
        country: true,
        city: true,
        photo: {
          select: {
            thumbUrl: true,
          },
        },
      },
      orderBy: { downloadedAt: 'desc' },
    });

    // Calculate unique users (by email)
    const uniqueEmails = new Set(downloads.filter(d => d.email).map(d => d.email));
    const uniqueUsers = uniqueEmails.size;

    // Top photos
    const photoDownloads = downloads.reduce((acc, d) => {
      acc[d.photoId] = (acc[d.photoId] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    const topPhotos = Object.entries(photoDownloads)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 10)
      .map(([photoId, count]) => {
        const download = downloads.find(d => d.photoId === photoId);
        return {
          photoId,
          downloads: count,
          thumbUrl: download?.photo.thumbUrl,
          percentage: ((count / downloads.length) * 100).toFixed(1),
        };
      });

    // Downloads by day
    const downloadsByDay = downloads.reduce((acc, d) => {
      const date = d.downloadedAt.toISOString().split('T')[0];
      acc[date] = (acc[date] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    const downloadsByDayArray = Object.entries(downloadsByDay)
      .map(([date, count]) => ({ date, count }))
      .sort((a, b) => a.date.localeCompare(b.date));

    // Top countries
    const countryDownloads = downloads.reduce((acc, d) => {
      if (d.country) {
        acc[d.country] = (acc[d.country] || 0) + 1;
      }
      return acc;
    }, {} as Record<string, number>);

    const topCountries = Object.entries(countryDownloads)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 10)
      .map(([country, count]) => ({ country, count }));

    // Emails collected
    const emailsCollected = downloads.filter(d => d.email).length;

    return {
      totalDownloads: event.totalFreeDownloads,
      uniqueUsers,
      topPhotos,
      downloadsByDay: downloadsByDayArray,
      topCountries,
      emailsCollected,
      recentDownloads: downloads.slice(0, 20).map(d => ({
        id: d.id,
        email: d.email,
        name: d.name,
        downloadedAt: d.downloadedAt,
        location: [d.city, d.country].filter(Boolean).join(', ') || 'Desconocido',
      })),
    };
  }

  /**
   * Export emails from free downloads
   */
  async exportEmails(eventId: string): Promise<string> {
    const downloads = await this.prisma.freeDownload.findMany({
      where: {
        eventId,
        email: { not: null },
      },
      select: {
        email: true,
        name: true,
        phone: true,
        bibNumber: true,
        downloadedAt: true,
      },
      orderBy: { downloadedAt: 'desc' },
    });

    // Create CSV
    const headers = ['Email', 'Nombre', 'Teléfono', 'Dorsal', 'Fecha Descarga'];
    const rows = downloads.map(d => [
      d.email,
      d.name || '',
      d.phone || '',
      d.bibNumber || '',
      d.downloadedAt.toISOString(),
    ]);

    const csv = [
      headers.join(','),
      ...rows.map(row => row.map(cell => `"${cell}"`).join(',')),
    ].join('\n');

    return csv;
  }
}
