import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { UserRole } from '@shared/types';
import { Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import { PrismaService } from '../common/services/prisma.service';
import { EventsService } from '../events/events.service';
import { CreateEventDto } from '../events/dto/create-event.dto';
import { UpdateEventDto } from '../events/dto/update-event.dto';
import { UploadsService } from '../uploads/uploads.service';
import { CompleteBatchDto, PresignBatchDto } from '../uploads/dto/presign-batch.dto';
import { PartnerPrincipal } from './partner-api.types';
import { PartnerListQueryDto } from './dto/partner-api.dto';
import { PhotosService } from '../photos/photos.service';
import { SearchService } from '../search/search.service';
import { FaceSearchService } from '../search/face-search.service';
import { AddBibDto } from '../photos/dto/add-bib.dto';
import { ReviewPhotoDto } from '../events/dto/review-photo.dto';
import { PartnerWebhooksService } from './partner-webhooks.service';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { SponsorsService } from '../sponsors/sponsors.service';
import { FreeDownloadsService } from '../events/free-downloads.service';
import { UpdateWorkspaceDto } from '../workspaces/dto/update-workspace.dto';
import { CreateSponsorDto } from '../sponsors/dto/create-sponsor.dto';
import { UpdateSponsorDto } from '../sponsors/dto/update-sponsor.dto';
import { AttachEventSponsorDto } from '../sponsors/dto/attach-event-sponsor.dto';
import { InviteContributorDto } from '../events/dto/invite-contributor.dto';
import { Request } from 'express';

@Injectable()
export class PartnerApiService {
  private readonly logger = new Logger(PartnerApiService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsService,
    private readonly uploads: UploadsService,
    private readonly photos: PhotosService,
    private readonly search: SearchService,
    private readonly faceSearch: FaceSearchService,
    private readonly webhooks: PartnerWebhooksService,
    private readonly workspaces: WorkspacesService,
    private readonly sponsors: SponsorsService,
    private readonly freeDownloads: FreeDownloadsService,
  ) {}

  async listEvents(principal: PartnerPrincipal, query: PartnerListQueryDto) {
    const where: Prisma.EventWhereInput = { workspaceId: principal.workspaceId, deletedAt: query.archived === 'true' ? { not: null } : null };
    const [items, total] = await Promise.all([
      this.prisma.event.findMany({
        where,
        select: {
          id: true,
          name: true,
          slug: true,
          date: true,
          location: true,
          imageUrl: true,
          commerceMode: true,
          pricing: true,
          bibRules: true,
          requiresPhotoApproval: true,
          isPublished: true,
          publishedAt: true,
          deletedAt: true,
          createdAt: true,
          _count: { select: { photos: true } },
        },
        orderBy: [{ date: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.event.count({ where }),
    ]);
    return { items, pagination: this.pagination(query.page, query.limit, total) };
  }

  async createEvent(principal: PartnerPrincipal, dto: CreateEventDto, idempotencyKey: string) {
    this.assertPublishScope(principal, dto.isPublished);
    return this.idempotent(principal, idempotencyKey, 'events.create', dto, async () => {
      const result = await this.events.create({ ...dto, workspaceId: principal.workspaceId }, principal.actorUserId);
      await this.emit(principal.workspaceId, 'event.created', result);
      return result;
    });
  }

  async getEvent(principal: PartnerPrincipal, eventId: string) {
    await this.assertEventInWorkspace(principal.workspaceId, eventId);
    return this.events.findOneForUser(eventId, principal.actorUserId, principal.actorRole as UserRole);
  }

  async updateEvent(principal: PartnerPrincipal, eventId: string, dto: UpdateEventDto) {
    await this.assertEventInWorkspace(principal.workspaceId, eventId);
    this.assertPublishScope(principal, dto.isPublished);
    const result = await this.events.update(eventId, dto, principal.actorUserId, principal.actorRole as UserRole);
    await this.emit(principal.workspaceId, 'event.updated', result);
    return result;
  }

  async getGalleryConfig(principal: PartnerPrincipal, eventId: string) {
    await this.assertEventInWorkspace(principal.workspaceId, eventId);
    return this.prisma.event.findUnique({ where: { id: eventId }, select: {
      id: true, slug: true, imageUrl: true, isPublished: true, publishedAt: true,
      commerceMode: true, isFreeDownload: true, freeDownloadUntil: true,
      requireEmailForFree: true, freeDownloadLimit: true, sponsorOverlayEnabled: true,
      requiresPhotoApproval: true, totalFreeDownloads: true,
    } });
  }

  async updateGalleryConfig(principal: PartnerPrincipal, eventId: string, dto: any) {
    await this.assertEventInWorkspace(principal.workspaceId, eventId);
    this.assertPublishScope(principal, dto.isPublished);
    const { isFreeDownload, freeDownloadUntil, requireEmailForFree, freeDownloadLimit, ...managed } = dto;
    const audienceData: Prisma.EventUpdateInput = {};
    if (isFreeDownload !== undefined) audienceData.isFreeDownload = isFreeDownload;
    if (freeDownloadUntil !== undefined) audienceData.freeDownloadUntil = freeDownloadUntil ? new Date(freeDownloadUntil) : null;
    if (requireEmailForFree !== undefined) audienceData.requireEmailForFree = requireEmailForFree;
    if (freeDownloadLimit !== undefined) audienceData.freeDownloadLimit = freeDownloadLimit;
    if (Object.keys(audienceData).length) await this.prisma.event.update({ where: { id: eventId }, data: audienceData });
    const result = Object.keys(managed).length
      ? await this.events.update(eventId, managed, principal.actorUserId, principal.actorRole as UserRole)
      : await this.prisma.event.findUnique({ where: { id: eventId } });
    await this.emit(principal.workspaceId, 'event.gallery.updated', { eventId, config: dto });
    return result;
  }

  async uploadEventCover(principal: PartnerPrincipal, eventId: string, file: Express.Multer.File) {
    await this.assertEventInWorkspace(principal.workspaceId, eventId);
    const result = await this.events.uploadEventImage(eventId, file, principal.actorUserId, principal.actorRole as UserRole);
    await this.emit(principal.workspaceId, 'event.cover.updated', { eventId, imageUrl: result.imageUrl });
    return result;
  }

  async removeEventCover(principal: PartnerPrincipal, eventId: string) {
    await this.assertEventInWorkspace(principal.workspaceId, eventId);
    const result = await this.events.removeEventImage(eventId, principal.actorUserId, principal.actorRole as UserRole);
    await this.emit(principal.workspaceId, 'event.cover.removed', { eventId });
    return result;
  }

  async lowConfidenceBibs(principal: PartnerPrincipal, eventId: string, threshold: number, page: number, limit: number) {
    await this.assertEventInWorkspace(principal.workspaceId, eventId);
    return this.events.getLowConfidenceBibs(eventId, principal.actorUserId, principal.actorRole as UserRole, threshold, page, limit);
  }

  async inviteContributor(principal: PartnerPrincipal, eventId: string, dto: InviteContributorDto) {
    await this.assertEventInWorkspace(principal.workspaceId, eventId);
    const result = await this.events.inviteContributor(eventId, dto, principal.actorUserId, principal.actorRole as UserRole);
    await this.emit(principal.workspaceId, 'event.contributor.invited', { eventId, contributor: result.invitation });
    return result;
  }

  async listContributors(principal: PartnerPrincipal, eventId: string) {
    await this.assertEventInWorkspace(principal.workspaceId, eventId);
    return this.events.listContributors(eventId, principal.actorUserId, principal.actorRole as UserRole);
  }

  async revokeContributor(principal: PartnerPrincipal, eventId: string, contributorId: string) {
    await this.assertEventInWorkspace(principal.workspaceId, eventId);
    const result = await this.events.revokeContributor(eventId, contributorId, principal.actorUserId, principal.actorRole as UserRole);
    await this.emit(principal.workspaceId, 'event.contributor.revoked', { eventId, contributorId });
    return result;
  }

  async listSponsors(principal: PartnerPrincipal) {
    return this.sponsors.list(principal.workspaceId, principal.actorUserId);
  }

  async createSponsor(principal: PartnerPrincipal, dto: CreateSponsorDto) {
    return this.sponsors.create(principal.workspaceId, dto, principal.actorUserId);
  }

  async updateSponsor(principal: PartnerPrincipal, sponsorId: string, dto: UpdateSponsorDto) {
    return this.sponsors.update(principal.workspaceId, sponsorId, dto, principal.actorUserId);
  }

  async removeSponsor(principal: PartnerPrincipal, sponsorId: string) {
    const sponsor = await this.prisma.sponsor.findFirst({ where: { id: sponsorId, workspaceId: principal.workspaceId } });
    if (!sponsor) throw new NotFoundException('Patrocinador no encontrado');
    return this.prisma.sponsor.update({ where: { id: sponsorId }, data: { isActive: false } });
  }

  async listEventSponsors(principal: PartnerPrincipal, eventId: string) {
    await this.assertEventInWorkspace(principal.workspaceId, eventId);
    return this.prisma.eventSponsor.findMany({ where: { eventId }, include: { sponsor: true }, orderBy: { priority: 'desc' } });
  }

  async attachSponsor(principal: PartnerPrincipal, eventId: string, dto: AttachEventSponsorDto) {
    await this.assertEventInWorkspace(principal.workspaceId, eventId);
    const result = await this.sponsors.attach(eventId, dto, principal.actorUserId, principal.actorRole as UserRole);
    await this.emit(principal.workspaceId, 'event.sponsor.attached', { eventId, sponsorId: dto.sponsorId });
    return result;
  }

  async detachSponsor(principal: PartnerPrincipal, eventId: string, sponsorId: string) {
    await this.assertEventInWorkspace(principal.workspaceId, eventId);
    const result = await this.sponsors.detach(eventId, sponsorId, principal.actorUserId, principal.actorRole as UserRole);
    await this.emit(principal.workspaceId, 'event.sponsor.detached', { eventId, sponsorId });
    return result;
  }

  async createUploadBatch(principal: PartnerPrincipal, eventId: string, totalFiles: number, idempotencyKey: string) {
    await this.assertEventInWorkspace(principal.workspaceId, eventId);
    return this.idempotent(principal, idempotencyKey, 'upload-batches.create', { eventId, totalFiles }, async () => {
      const job = await this.uploads.initiateBatchUpload(
        { eventId, totalFiles }, principal.actorUserId, principal.actorRole as UserRole,
      );
      const result = { id: job.id, eventId, totalFiles, status: job.status, createdAt: job.createdAt };
      await this.emit(principal.workspaceId, 'upload.batch.created', result);
      return result;
    });
  }

  async presignFiles(principal: PartnerPrincipal, batchId: string, dto: PresignBatchDto) {
    await this.assertBatchInWorkspace(principal.workspaceId, batchId);
    return this.uploads.presignBatchFiles(
      batchId,
      dto.files,
      principal.actorUserId,
      principal.actorRole as UserRole,
      principal.workspaceId,
    );
  }

  async completeFiles(principal: PartnerPrincipal, batchId: string, dto: CompleteBatchDto) {
    await this.assertBatchInWorkspace(principal.workspaceId, batchId);
    return this.uploads.completeBatchFiles(
      batchId,
      dto.clientFileIds,
      principal.actorUserId,
      principal.workspaceId,
    );
  }

  async getBatch(principal: PartnerPrincipal, batchId: string) {
    await this.assertBatchInWorkspace(principal.workspaceId, batchId);
    return this.uploads.getBatchUploadStatusDetailed(batchId, principal.actorUserId, principal.workspaceId);
  }

  async listBatches(principal: PartnerPrincipal, eventId: string, query: PartnerListQueryDto) {
    await this.assertEventInWorkspace(principal.workspaceId, eventId);
    const where = { eventId };
    const [items, total] = await Promise.all([
      this.prisma.batchUploadJob.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        select: {
          id: true, eventId: true, status: true, totalFiles: true, uploadedFiles: true,
          processedFiles: true, faceFiles: true, failedFaces: true, failedGemini: true,
          failedWatermarks: true, createdAt: true, updatedAt: true,
        },
      }),
      this.prisma.batchUploadJob.count({ where }),
    ]);
    return { items, pagination: this.pagination(query.page, query.limit, total) };
  }

  async listPhotos(principal: PartnerPrincipal, eventId: string, query: PartnerListQueryDto) {
    await this.assertEventInWorkspace(principal.workspaceId, eventId);
    return this.events.getEventPhotos(
      eventId,
      principal.actorUserId,
      principal.actorRole as UserRole,
      query.page,
      query.limit,
      query.status as any,
      query.publicationStatus as any,
    );
  }

  async getPhoto(principal: PartnerPrincipal, photoId: string) {
    await this.assertPhotoInWorkspace(principal.workspaceId, photoId);
    return this.prisma.photo.findUnique({
      where: { id: photoId },
      select: {
        id: true, eventId: true, batchJobId: true, width: true, height: true, takenAt: true,
        status: true, publicationStatus: true, reviewNote: true, reviewedAt: true,
        derivativesProcessedAt: true, ocrProcessedAt: true, faceProcessedAt: true,
        processingCompletedAt: true, watermarkFailedAt: true, ocrFailedAt: true,
        faceFailedAt: true, createdAt: true,
        bibs: { select: { id: true, bib: true, confidence: true, bbox: true, source: true }, orderBy: { confidence: 'desc' } },
        faces: { select: { id: true, confidence: true, bbox: true, age: true, gender: true }, orderBy: { confidence: 'desc' } },
      },
    }).then(photo => photo && ({
      ...photo,
      bibs: photo.bibs.map(bib => ({ ...bib, id: bib.id.toString(), confidence: Number(bib.confidence) })),
    }));
  }

  async getPhotoAssets(principal: PartnerPrincipal, photoId: string) {
    await this.assertPhotoInWorkspace(principal.workspaceId, photoId);
    const photo = await this.prisma.photo.findUnique({
      where: { id: photoId },
      select: { id: true, eventId: true, status: true, width: true, height: true, thumbUrl: true, watermarkUrl: true, watermarkThumbUrl: true, derivativesProcessedAt: true, watermarkFailedAt: true },
    });
    if (!photo) throw new NotFoundException('Fotografía no encontrada');
    return {
      photoId: photo.id,
      eventId: photo.eventId,
      status: photo.status,
      width: photo.width,
      height: photo.height,
      ready: Boolean(photo.derivativesProcessedAt && photo.watermarkUrl),
      assets: {
        thumbnail: photo.thumbUrl,
        watermark: photo.watermarkUrl,
        watermarkThumbnail: photo.watermarkThumbUrl || photo.watermarkUrl,
      },
      derivativesProcessedAt: photo.derivativesProcessedAt,
      watermarkFailedAt: photo.watermarkFailedAt,
    };
  }

  async processPhoto(principal: PartnerPrincipal, photoId: string) {
    await this.assertPhotoInWorkspace(principal.workspaceId, photoId);
    return this.photos.triggerProcessing(photoId, principal.actorUserId, principal.actorRole as UserRole);
  }

  async addBib(principal: PartnerPrincipal, photoId: string, dto: AddBibDto) {
    await this.assertPhotoInWorkspace(principal.workspaceId, photoId);
    return this.photos.addBibCorrection(
      photoId, dto.bib, principal.actorUserId, principal.actorRole as UserRole, dto.confidence, dto.bbox,
    );
  }

  async removeBib(principal: PartnerPrincipal, photoId: string, bibId: string) {
    await this.assertPhotoInWorkspace(principal.workspaceId, photoId);
    return this.photos.removeBib(photoId, bibId, principal.actorUserId, principal.actorRole as UserRole);
  }

  async reviewPhoto(principal: PartnerPrincipal, eventId: string, photoId: string, dto: ReviewPhotoDto) {
    await this.assertEventInWorkspace(principal.workspaceId, eventId);
    await this.assertPhotoInEvent(eventId, photoId);
    const result = await this.events.reviewPhoto(eventId, photoId, dto, principal.actorUserId, principal.actorRole as UserRole);
    await this.emit(principal.workspaceId, 'photo.reviewed', { eventId, photoId, status: dto.status });
    return result;
  }

  async deletePhoto(principal: PartnerPrincipal, photoId: string) {
    await this.assertPhotoInWorkspace(principal.workspaceId, photoId);
    const result = await this.photos.delete(photoId, principal.actorUserId, principal.actorRole as UserRole);
    await this.emit(principal.workspaceId, 'photo.deleted', { photoId });
    return result;
  }

  async downloadPhoto(principal: PartnerPrincipal, photoId: string, expiresIn: number) {
    await this.assertPhotoInWorkspace(principal.workspaceId, photoId);
    const result = await this.photos.generateSecureDownloadUrl(
      photoId, principal.actorUserId, principal.actorRole as UserRole, expiresIn,
    );
    await this.prisma.auditLog.create({
      data: {
        userId: principal.actorUserId,
        photoId,
        action: 'PARTNER_ORIGINAL_DOWNLOAD_URL_CREATED',
        data: { apiClientId: principal.apiClientId, keyPrefix: principal.keyPrefix, expiresIn },
      },
    });
    await this.emit(principal.workspaceId, 'photo.download_url.created', { photoId, expiresIn });
    return { ...result, expiresIn };
  }

  async freeDownloadPhoto(principal: PartnerPrincipal, eventId: string, photoId: string, input: any, req: Request) {
    await this.assertEventInWorkspace(principal.workspaceId, eventId);
    await this.assertPhotoInEvent(eventId, photoId);
    const result = await this.freeDownloads.downloadFreePhoto(eventId, photoId, input, req);
    await this.emit(principal.workspaceId, 'photo.free_downloaded', { eventId, photoId, variant: result.variant, sponsors: result.sponsors });
    return result;
  }

  async bulkReview(principal: PartnerPrincipal, eventId: string, photoIds: string[], status: any, note?: string) {
    await this.assertEventInWorkspace(principal.workspaceId, eventId);
    if (status === 'PENDING_REVIEW') throw new BadRequestException('La revisión masiva debe aprobar o rechazar');
    await this.assertPhotosInEvent(eventId, photoIds);
    const now = new Date();
    const result = await this.prisma.photo.updateMany({
      where: { id: { in: photoIds }, eventId },
      data: { publicationStatus: status, reviewNote: note, reviewedAt: now, reviewedById: principal.actorUserId },
    });
    await this.emit(principal.workspaceId, 'photo.bulk.completed', { eventId, operation: 'review', requested: photoIds.length, affected: result.count });
    return { requested: photoIds.length, affected: result.count, status };
  }

  async bulkProcess(principal: PartnerPrincipal, eventId: string, photoIds: string[]) {
    await this.assertEventInWorkspace(principal.workspaceId, eventId);
    await this.assertPhotosInEvent(eventId, photoIds);
    return this.runBulk(principal, eventId, 'process', photoIds, id => this.photos.triggerProcessing(id, principal.actorUserId, principal.actorRole as UserRole));
  }

  async bulkDelete(principal: PartnerPrincipal, eventId: string, photoIds: string[]) {
    await this.assertEventInWorkspace(principal.workspaceId, eventId);
    await this.assertPhotosInEvent(eventId, photoIds);
    return this.runBulk(principal, eventId, 'delete', photoIds, id => this.photos.delete(id, principal.actorUserId, principal.actorRole as UserRole));
  }

  async bulkDownload(principal: PartnerPrincipal, eventId: string, photoIds: string[], expiresIn: number) {
    await this.assertEventInWorkspace(principal.workspaceId, eventId);
    await this.assertPhotosInEvent(eventId, photoIds);
    const data = await Promise.all(photoIds.map(async photoId => ({
      photoId,
      ...(await this.photos.generateSecureDownloadUrl(photoId, principal.actorUserId, principal.actorRole as UserRole, expiresIn)),
      expiresIn,
    })));
    await this.prisma.auditLog.create({ data: {
      userId: principal.actorUserId,
      action: 'PARTNER_BULK_ORIGINAL_DOWNLOAD_URLS_CREATED',
      data: { apiClientId: principal.apiClientId, keyPrefix: principal.keyPrefix, eventId, photoIds, expiresIn },
    } });
    await this.emit(principal.workspaceId, 'photo.bulk.completed', { eventId, operation: 'download', requested: photoIds.length, affected: data.length });
    return data;
  }

  async eventAnalytics(principal: PartnerPrincipal, eventId: string) {
    await this.assertEventInWorkspace(principal.workspaceId, eventId);
    const [event, photoStatus, publicationStatus, metricTypes, freeDownloads] = await Promise.all([
      this.prisma.event.findUnique({ where: { id: eventId }, select: { id: true, totalFreeDownloads: true, createdAt: true, publishedAt: true } }),
      this.prisma.photo.groupBy({ by: ['status'], where: { eventId }, _count: true }),
      this.prisma.photo.groupBy({ by: ['publicationStatus'], where: { eventId }, _count: true }),
      this.prisma.metricEvent.groupBy({ by: ['type'], where: { eventId }, _count: true }),
      this.freeDownloads.getEventAnalytics(eventId, principal.actorUserId, principal.actorRole as UserRole),
    ]);
    return { event, photosByStatus: photoStatus, photosByPublicationStatus: publicationStatus, metrics: metricTypes, freeDownloads };
  }

  async exportPhotos(principal: PartnerPrincipal, eventId: string) {
    await this.assertEventInWorkspace(principal.workspaceId, eventId);
    const photos = await this.prisma.photo.findMany({
      where: { eventId }, orderBy: { createdAt: 'asc' },
      select: { id: true, status: true, publicationStatus: true, takenAt: true, createdAt: true, width: true, height: true, bibs: { select: { bib: true } } },
    });
    const csv = this.csv(['photoId', 'status', 'publicationStatus', 'bibs', 'takenAt', 'createdAt', 'width', 'height'], photos.map(p => [p.id, p.status, p.publicationStatus, p.bibs.map(b => b.bib).join('|'), p.takenAt?.toISOString() || '', p.createdAt.toISOString(), p.width || '', p.height || '']));
    return { filename: `photos-${eventId}.csv`, contentType: 'text/csv; charset=utf-8', content: csv };
  }

  async exportAudience(principal: PartnerPrincipal, eventId: string) {
    await this.assertEventInWorkspace(principal.workspaceId, eventId);
    const content = await this.freeDownloads.exportEmails(eventId, principal.actorUserId, principal.actorRole as UserRole);
    return { filename: `audience-${eventId}.csv`, contentType: 'text/csv; charset=utf-8', content };
  }

  async getWorkspace(principal: PartnerPrincipal) {
    return this.workspaces.findOneForMember(principal.workspaceId, principal.actorUserId);
  }

  async updateWorkspace(principal: PartnerPrincipal, dto: UpdateWorkspaceDto) {
    const result = await this.workspaces.update(principal.workspaceId, dto, principal.actorUserId);
    await this.emit(principal.workspaceId, 'workspace.brand.updated', { workspaceId: principal.workspaceId });
    return result;
  }

  async uploadWorkspaceAsset(principal: PartnerPrincipal, kind: 'logo' | 'cover', file: Express.Multer.File) {
    const result = await this.workspaces.uploadBrandAsset(principal.workspaceId, kind, file, principal.actorUserId);
    await this.emit(principal.workspaceId, 'workspace.brand.updated', { workspaceId: principal.workspaceId, kind });
    return result;
  }

  async removeWorkspaceAsset(principal: PartnerPrincipal, kind: 'logo' | 'cover') {
    const result = await this.workspaces.removeBrandAsset(principal.workspaceId, kind, principal.actorUserId);
    await this.emit(principal.workspaceId, 'workspace.brand.updated', { workspaceId: principal.workspaceId, kind });
    return result;
  }

  async verifyWorkspaceDomain(principal: PartnerPrincipal) {
    const result = await this.workspaces.verifyCustomDomain(principal.workspaceId, principal.actorUserId);
    await this.emit(principal.workspaceId, 'workspace.brand.updated', { workspaceId: principal.workspaceId, domainVerified: true });
    return result;
  }

  async searchByBib(principal: PartnerPrincipal, eventId: string, bib: string, limit: number, cursor?: string) {
    await this.assertEventInWorkspace(principal.workspaceId, eventId);
    return this.search.searchPhotosByBib(eventId, bib, limit, cursor, true);
  }

  async searchByFace(principal: PartnerPrincipal, eventId: string, input: { userImageBase64: string; threshold?: number }) {
    await this.assertEventInWorkspace(principal.workspaceId, eventId);
    return this.faceSearch.searchPhotosByFace(eventId, input, true);
  }

  async getFaceStats(principal: PartnerPrincipal, eventId: string) {
    await this.assertEventInWorkspace(principal.workspaceId, eventId);
    return this.faceSearch.getEventFaceStats(eventId, true);
  }

  async removeEvent(principal: PartnerPrincipal, eventId: string) {
    await this.assertEventInWorkspace(principal.workspaceId, eventId);
    const result = await this.prisma.event.update({ where: { id: eventId }, data: { deletedAt: new Date(), isPublished: false } });
    await this.emit(principal.workspaceId, 'event.deleted', { eventId });
    return result;
  }

  async restoreEvent(principal: PartnerPrincipal, eventId: string) {
    const event = await this.prisma.event.findFirst({ where: { id: eventId, workspaceId: principal.workspaceId, deletedAt: { not: null } } });
    if (!event) throw new NotFoundException('Evento archivado no encontrado');
    const result = await this.prisma.event.update({ where: { id: eventId }, data: { deletedAt: null } });
    await this.emit(principal.workspaceId, 'event.restored', { eventId });
    return result;
  }

  private async assertEventInWorkspace(workspaceId: string, eventId: string) {
    const event = await this.prisma.event.findFirst({
      where: { id: eventId, workspaceId, deletedAt: null },
      select: { id: true },
    });
    if (!event) throw new NotFoundException('Evento no encontrado');
  }

  private async assertBatchInWorkspace(workspaceId: string, batchId: string) {
    const batch = await this.prisma.batchUploadJob.findFirst({
      where: { id: batchId, event: { workspaceId, deletedAt: null } },
      select: { id: true },
    });
    if (!batch) throw new NotFoundException('Lote no encontrado');
  }

  private async assertPhotoInWorkspace(workspaceId: string, photoId: string) {
    const photo = await this.prisma.photo.findFirst({
      where: { id: photoId, event: { workspaceId, deletedAt: null } },
      select: { id: true },
    });
    if (!photo) throw new NotFoundException('Fotografía no encontrada');
  }

  private async assertPhotoInEvent(eventId: string, photoId: string) {
    const photo = await this.prisma.photo.findFirst({ where: { id: photoId, eventId }, select: { id: true } });
    if (!photo) throw new NotFoundException('Fotografía no encontrada');
  }

  private async assertPhotosInEvent(eventId: string, photoIds: string[]) {
    const count = await this.prisma.photo.count({ where: { id: { in: photoIds }, eventId } });
    if (count !== new Set(photoIds).size) throw new NotFoundException('Una o más fotografías no pertenecen al evento');
  }

  private async runBulk(principal: PartnerPrincipal, eventId: string, operation: string, ids: string[], action: (id: string) => Promise<unknown>) {
    const settled = await Promise.allSettled(ids.map(action));
    const results = settled.map((item, index) => item.status === 'fulfilled'
      ? { photoId: ids[index], ok: true }
      : { photoId: ids[index], ok: false, error: item.reason?.message || 'Error desconocido' });
    await this.emit(principal.workspaceId, 'photo.bulk.completed', { eventId, operation, requested: ids.length, succeeded: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length });
    return { operation, results };
  }

  private csv(headers: string[], rows: Array<Array<string | number>>) {
    const cell = (value: string | number) => {
      let safe = String(value);
      if (/^[=+\-@]/.test(safe)) safe = `'${safe}`;
      return `"${safe.replace(/"/g, '""')}"`;
    };
    return [headers.map(cell).join(','), ...rows.map(row => row.map(cell).join(','))].join('\n');
  }

  private assertPublishScope(principal: PartnerPrincipal, requested?: boolean) {
    if (requested && !principal.scopes.includes('events:publish')) {
      throw new ForbiddenException('Falta el permiso API: events:publish');
    }
  }

  private async idempotent<T>(
    principal: PartnerPrincipal,
    key: string,
    operation: string,
    request: unknown,
    execute: () => Promise<T>,
  ): Promise<T> {
    const normalizedKey = String(key || '').trim();
    if (!/^[A-Za-z0-9._:-]{8,200}$/.test(normalizedKey)) {
      throw new BadRequestException('Idempotency-Key es obligatorio y debe tener entre 8 y 200 caracteres seguros');
    }
    const requestHash = createHash('sha256').update(JSON.stringify(request)).digest('hex');
    try {
      await this.prisma.partnerIdempotencyRecord.create({
        data: {
          apiClientId: principal.apiClientId,
          workspaceId: principal.workspaceId,
          key: normalizedKey,
          operation,
          requestHash,
          expiresAt: new Date(Date.now() + 24 * 60 * 60_000),
        },
      });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
      const existing = await this.prisma.partnerIdempotencyRecord.findUnique({
        where: { apiClientId_key: { apiClientId: principal.apiClientId, key: normalizedKey } },
      });
      if (existing && existing.expiresAt <= new Date()) {
        await this.prisma.partnerIdempotencyRecord.delete({ where: { id: existing.id } });
        return this.idempotent(principal, normalizedKey, operation, request, execute);
      }
      if (!existing || existing.operation !== operation || existing.requestHash !== requestHash) {
        throw new ConflictException('Idempotency-Key ya fue utilizada con otra solicitud');
      }
      if (existing.response === null) throw new ConflictException('La solicitud con esta Idempotency-Key sigue en proceso');
      return existing.response as T;
    }

    try {
      const result = await execute();
      const serializable = JSON.parse(JSON.stringify(result));
      await this.prisma.partnerIdempotencyRecord.update({
        where: { apiClientId_key: { apiClientId: principal.apiClientId, key: normalizedKey } },
        data: { response: serializable },
      });
      return result;
    } catch (error) {
      await this.prisma.partnerIdempotencyRecord.deleteMany({
        where: { apiClientId: principal.apiClientId, key: normalizedKey, response: { equals: Prisma.DbNull } },
      }).catch(() => undefined);
      throw error;
    }
  }

  private async emit(workspaceId: string, eventType: any, data: unknown) {
    await this.webhooks.emit(workspaceId, eventType, data).catch(error => {
      this.logger.warn(`No se pudo registrar webhook ${eventType}: ${error?.message || error}`);
    });
  }

  private pagination(page: number, limit: number, total: number) {
    return { page, limit, total, pages: Math.ceil(total / limit) };
  }
}
