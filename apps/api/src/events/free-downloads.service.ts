import { Injectable, Logger, BadRequestException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../common/services/prisma.service';
import { StorageService } from '../common/services/storage.service';
import { Request } from 'express';
import { createHash, createHmac } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { EventsService } from './events.service';
import { UserRole } from '@shared/types';
import { Prisma } from '@prisma/client';

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
    private eventsService: EventsService,
    private configService: ConfigService,
  ) {}

  /**
   * Download a photo for free with user tracking
   */
  async downloadFreePhoto(
    eventId: string,
    photoId: string,
    userData: FreeDownloadRequest,
    req: Request,
  ): Promise<{
    downloadUrl: string;
    expiresIn: number;
    variant: 'CLEAN' | 'SPONSORED';
    sponsors: Array<{ id: string; name: string; logoUrl: string }>;
  }> {
    const normalizedEmail = userData.email?.trim().toLowerCase() || undefined;
    const privacySecret = this.configService.get('METRICS_HASH_SECRET') || this.configService.get('ORDER_ACCESS_SECRET') || 'lucilamon-local-downloads';
    const clientIpHash = createHmac('sha256', privacySecret).update(req.ip || 'unknown').digest('hex');
    // 1. Get event and verify it's free
    const event = await this.prisma.event.findUnique({
      where: {
        id: eventId,
        deletedAt: null,
        isPublished: true,
        commerceMode: 'FREE',
      },
      select: {
        id: true,
        isFreeDownload: true,
        freeDownloadUntil: true,
        requireEmailForFree: true,
        freeDownloadLimit: true,
        commerceMode: true,
        sponsorOverlayEnabled: true,
        workspaceId: true,
        eventSponsors: {
          where: {
            status: 'ACTIVE',
            sponsor: { isActive: true },
            OR: [{ startsAt: null }, { startsAt: { lte: new Date() } }],
            AND: [{ OR: [{ endsAt: null }, { endsAt: { gte: new Date() } }] }],
          },
          // El orden forma parte de la imagen y de su firma de caché. Resolver
          // empates evita variantes distintas para la misma campaña.
          orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
          include: { sponsor: true },
        },
      },
    });

    if (!event) {
      throw new BadRequestException('Evento no encontrado');
    }

    const supportsFreeDownloads = event.isFreeDownload || event.commerceMode === 'FREE';
    if (!supportsFreeDownloads) {
      throw new ForbiddenException('Este evento no permite descargas gratuitas');
    }

    // 2. Check if free download period is still valid
    if (event.freeDownloadUntil && new Date() > event.freeDownloadUntil) {
      throw new BadRequestException('El período de descargas gratuitas ha expirado');
    }

    // 3. Verify email if required
    if (event.requireEmailForFree && !normalizedEmail) {
      throw new BadRequestException('Email requerido para descargar');
    }

    // 5. Get photo
    const photo = await this.prisma.photo.findUnique({
      where: { id: photoId },
      select: {
        id: true,
        originalUrl: true,
        eventId: true,
        cloudinaryId: true,
        status: true,
        publicationStatus: true,
      },
    });

    if (!photo) {
      throw new BadRequestException('Foto no encontrada');
    }

    if (photo.eventId !== eventId) {
      throw new BadRequestException('La foto no pertenece a este evento');
    }

    if (photo.status !== 'PROCESSED' || photo.publicationStatus !== 'APPROVED') {
      throw new ForbiddenException('La fotografía todavía no está disponible para descarga');
    }

    const referer = req.headers['referer'] || req.headers['referrer'];

    const activeSponsors = event.sponsorOverlayEnabled
      // El compositor admite seis logos. Mantener aquí el mismo límite evita
      // reportar exposiciones de sponsors que no aparecieron en la imagen.
      ? event.eventSponsors.filter(item => item.requiredOnFreeDownloads).slice(0, 6)
      : [];
    let assetKey = photo.cloudinaryId;
    let variant: 'CLEAN' | 'SPONSORED' = 'CLEAN';

    if (activeSponsors.length > 0) {
      variant = 'SPONSORED';
      const signature = createHash('sha256')
        .update(activeSponsors.map(item => `${item.id}:${item.priority}:${item.sponsor.logoUrl}:${JSON.stringify(item.placement || {})}`).join('|'))
        .digest('hex')
        .slice(0, 20);
      let asset = await this.prisma.downloadAsset.findUnique({
        where: { photoId_variant_sponsorSignature: { photoId, variant: 'SPONSORED', sponsorSignature: signature } },
      });
      if (!asset) {
        const generated = await this.storageService.generateSponsoredAsset(
          photo.cloudinaryId,
          eventId,
          photoId,
          signature,
          activeSponsors.map(item => ({ logoUrl: item.sponsor.logoUrl, placement: item.placement })),
        );
        try {
          asset = await this.prisma.downloadAsset.create({
            data: {
              eventId,
              photoId,
              variant: 'SPONSORED',
              sponsorSignature: signature,
              storageKey: generated.storageKey,
              url: generated.url,
            },
          });
        } catch (error) {
          if ((error as { code?: string }).code !== 'P2002') throw error;
          asset = await this.prisma.downloadAsset.findUnique({
            where: { photoId_variant_sponsorSignature: { photoId, variant: 'SPONSORED', sponsorSignature: signature } },
          });
          if (!asset) throw error;
        }
      }
      assetKey = asset.storageKey;
    }

    const downloadUrl = await this.storageService.generateSecureDownloadUrl(assetKey, 900);

    // Reserve the allowance only after the downloadable asset exists. Advisory
    // locks keep concurrent requests for the same email/IP from bypassing limits.
    await this.prisma.$transaction(async tx => {
      if (event.freeDownloadLimit) {
        const lockKeys = [
          `${eventId}:ip:${clientIpHash}`,
          ...(normalizedEmail ? [`${eventId}:email:${normalizedEmail}`] : []),
        ].sort();
        for (const lockKey of lockKeys) {
          // La función devuelve `void`. `$queryRaw` intenta deserializar esa
          // columna y algunos adaptadores/versions de Prisma fallan con P2010.
          // `$executeRaw` conserva el bloqueo transaccional sin materializarla.
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
        }
        const downloadCount = await tx.freeDownload.count({
          where: {
            eventId,
            OR: normalizedEmail
              ? [{ email: normalizedEmail }, { ipAddress: clientIpHash }]
              : [{ ipAddress: clientIpHash }],
          },
        });
        if (downloadCount >= event.freeDownloadLimit) {
          throw new BadRequestException(`Has alcanzado el límite de ${event.freeDownloadLimit} descargas gratuitas para este evento`);
        }
      }

      await tx.freeDownload.create({
        data: {
          eventId,
          photoId,
          email: normalizedEmail || null,
          name: userData.name?.trim() || null,
          phone: userData.phone?.trim() || null,
          bibNumber: userData.bibNumber?.trim() || null,
          ipAddress: clientIpHash,
          userAgent: req.headers['user-agent'] || null,
          referer: Array.isArray(referer) ? referer[0] : referer || null,
        },
      });
      await tx.event.update({
        where: { id: eventId },
        data: { totalFreeDownloads: { increment: 1 } },
      });
    });

    this.logger.log(`Free download tracked: Event ${eventId}, Photo ${photoId}`);

    await this.prisma.metricEvent.createMany({
      data: [
        {
          type: 'FREE_DOWNLOAD',
          workspaceId: event.workspaceId,
          eventId,
          photoId,
          source: Array.isArray(referer) ? referer[0] : referer || undefined,
          metadata: { variant },
        },
        ...(variant === 'SPONSORED' ? [{
          type: 'SPONSOR_DOWNLOAD_EXPOSURE' as const,
          workspaceId: event.workspaceId,
          eventId,
          photoId,
          metadata: { sponsorIds: activeSponsors.map(item => item.sponsorId) },
        }] : []),
      ],
    });

    return {
      downloadUrl,
      expiresIn: 900,
      variant,
      sponsors: activeSponsors.map(item => ({ id: item.sponsor.id, name: item.sponsor.name, logoUrl: item.sponsor.logoUrl })),
    };
  }

  /**
   * Get analytics for an event's free downloads
   */
  async getEventAnalytics(eventId: string, userId: string, userRole: UserRole) {
    await this.eventsService.assertCanManageAudienceData(eventId, userId, userRole);
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

    const [statsRows, topPhotoRows, dayRows, countryRows, recentDownloads] = await Promise.all([
      this.prisma.$queryRaw<Array<{ total: bigint; uniqueUsers: bigint; emailsCollected: bigint }>>(Prisma.sql`
        SELECT
          COUNT(*)::bigint AS "total",
          COUNT(DISTINCT "email") FILTER (WHERE "email" IS NOT NULL)::bigint AS "uniqueUsers",
          COUNT("email")::bigint AS "emailsCollected"
        FROM "free_downloads"
        WHERE "event_id" = ${eventId}::uuid
      `),
      this.prisma.$queryRaw<Array<{ photoId: string; downloads: bigint; thumbUrl: string | null }>>(Prisma.sql`
        SELECT fd."photo_id"::text AS "photoId", COUNT(*)::bigint AS "downloads", MAX(p."thumb_url") AS "thumbUrl"
        FROM "free_downloads" fd
        JOIN "photos" p ON p."id" = fd."photo_id"
        WHERE fd."event_id" = ${eventId}::uuid
        GROUP BY fd."photo_id"
        ORDER BY COUNT(*) DESC, fd."photo_id"
        LIMIT 10
      `),
      this.prisma.$queryRaw<Array<{ date: string; count: bigint }>>(Prisma.sql`
        SELECT TO_CHAR("downloaded_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS "date", COUNT(*)::bigint AS "count"
        FROM "free_downloads"
        WHERE "event_id" = ${eventId}::uuid
        GROUP BY 1
        ORDER BY 1
      `),
      this.prisma.$queryRaw<Array<{ country: string; count: bigint }>>(Prisma.sql`
        SELECT "country", COUNT(*)::bigint AS "count"
        FROM "free_downloads"
        WHERE "event_id" = ${eventId}::uuid AND "country" IS NOT NULL
        GROUP BY "country"
        ORDER BY COUNT(*) DESC, "country"
        LIMIT 10
      `),
      this.prisma.freeDownload.findMany({
        where: { eventId },
        select: { id: true, email: true, name: true, downloadedAt: true, country: true, city: true },
        orderBy: { downloadedAt: 'desc' },
        take: 20,
      }),
    ]);

    const stats = statsRows[0] || { total: 0n, uniqueUsers: 0n, emailsCollected: 0n };
    const totalDownloads = Number(stats.total);
    const topPhotos = topPhotoRows.map(row => ({
      photoId: row.photoId,
      downloads: Number(row.downloads),
      thumbUrl: row.thumbUrl,
      percentage: totalDownloads > 0 ? ((Number(row.downloads) / totalDownloads) * 100).toFixed(1) : '0.0',
    }));
    const downloadsByDayArray = dayRows.map(row => ({ date: row.date, count: Number(row.count) }));
    const topCountries = countryRows.map(row => ({ country: row.country, count: Number(row.count) }));

    return {
      totalDownloads,
      uniqueUsers: Number(stats.uniqueUsers),
      topPhotos,
      downloadsByDay: downloadsByDayArray,
      topCountries,
      emailsCollected: Number(stats.emailsCollected),
      recentDownloads: recentDownloads.map(d => ({
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
  async exportEmails(eventId: string, userId: string, userRole: UserRole): Promise<string> {
    await this.eventsService.assertCanManageAudienceData(eventId, userId, userRole);
    const exportCount = await this.prisma.freeDownload.count({ where: { eventId, email: { not: null } } });
    if (exportCount > 100_000) {
      throw new BadRequestException('La exportación supera 100,000 registros; reduce el período antes de exportar');
    }
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

    const csvCell = (value: string | null) => {
      const escapedFormula = value && /^[=+\-@]/.test(value) ? `'${value}` : value || '';
      return `"${escapedFormula.replace(/"/g, '""')}"`;
    };
    const csv = [
      headers.join(','),
      ...rows.map(row => row.map(cell => csvCell(cell)).join(',')),
    ].join('\n');

    return csv;
  }
}
