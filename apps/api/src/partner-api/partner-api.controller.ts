import { BadRequestException, Body, Controller, Delete, Get, Headers, Param, Patch, Post, Query, Req, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { ApiResponse } from '@shared/types';
import { CreateEventDto } from '../events/dto/create-event.dto';
import { UpdateEventDto } from '../events/dto/update-event.dto';
import { CompleteBatchDto, PresignBatchDto } from '../uploads/dto/presign-batch.dto';
import { CreatePartnerUploadBatchDto, PartnerBibSearchQueryDto, PartnerBulkDownloadDto, PartnerBulkPhotoIdsDto, PartnerBulkReviewDto, PartnerDownloadDto, PartnerFaceSearchDto, PartnerFreeDownloadDto, PartnerGalleryConfigDto, PartnerListQueryDto, PartnerLowConfidenceQueryDto } from './dto/partner-api.dto';
import { PartnerApiKeyGuard } from './partner-api-key.guard';
import { PartnerApiService } from './partner-api.service';
import { PartnerRequest } from './partner-api.types';
import { RequirePartnerScopes } from './require-partner-scopes.decorator';
import { AddBibDto } from '../photos/dto/add-bib.dto';
import { ReviewPhotoDto } from '../events/dto/review-photo.dto';
import { PartnerWebhooksService } from './partner-webhooks.service';
import { CreatePartnerWebhookDto, UpdatePartnerWebhookDto } from './dto/partner-webhook.dto';
import { InviteContributorDto } from '../events/dto/invite-contributor.dto';
import { CreateSponsorDto } from '../sponsors/dto/create-sponsor.dto';
import { UpdateSponsorDto } from '../sponsors/dto/update-sponsor.dto';
import { AttachEventSponsorDto } from '../sponsors/dto/attach-event-sponsor.dto';
import { UpdateWorkspaceDto } from '../workspaces/dto/update-workspace.dto';

@Controller('partner')
@UseGuards(PartnerApiKeyGuard)
@Throttle(600, 60)
export class PartnerApiController {
  constructor(private readonly partner: PartnerApiService, private readonly webhooks: PartnerWebhooksService) {}

  @Get('events')
  @RequirePartnerScopes('events:read')
  async listEvents(@Req() req: PartnerRequest, @Query() query: PartnerListQueryDto): Promise<ApiResponse> {
    const result = await this.partner.listEvents(req.partner, query);
    return { data: result.items, meta: { pagination: result.pagination } };
  }

  @Post('events')
  @RequirePartnerScopes('events:write')
  async createEvent(@Req() req: PartnerRequest, @Body() dto: CreateEventDto, @Headers('idempotency-key') key: string): Promise<ApiResponse> {
    return { data: await this.partner.createEvent(req.partner, dto, key) };
  }

  @Get('events/:eventId')
  @RequirePartnerScopes('events:read')
  async getEvent(@Req() req: PartnerRequest, @Param('eventId') eventId: string): Promise<ApiResponse> {
    return { data: await this.partner.getEvent(req.partner, eventId) };
  }

  @Patch('events/:eventId')
  @RequirePartnerScopes('events:write')
  async updateEvent(
    @Req() req: PartnerRequest,
    @Param('eventId') eventId: string,
    @Body() dto: UpdateEventDto,
  ): Promise<ApiResponse> {
    return { data: await this.partner.updateEvent(req.partner, eventId, dto) };
  }

  @Post('events/:eventId/cover')
  @RequirePartnerScopes('events:write')
  @UseInterceptors(FileInterceptor('image', { limits: { fileSize: 5 * 1024 * 1024, files: 1 } }))
  async uploadEventCover(@Req() req: PartnerRequest, @Param('eventId') eventId: string, @UploadedFile() file: Express.Multer.File): Promise<ApiResponse> {
    if (!file) throw new BadRequestException('Se requiere el campo multipart image');
    return { data: await this.partner.uploadEventCover(req.partner, eventId, file) };
  }

  @Delete('events/:eventId/cover')
  @RequirePartnerScopes('events:write')
  async removeEventCover(@Req() req: PartnerRequest, @Param('eventId') eventId: string): Promise<ApiResponse> {
    return { data: await this.partner.removeEventCover(req.partner, eventId) };
  }

  @Post('events/:eventId/restore')
  @RequirePartnerScopes('events:write')
  async restoreEvent(@Req() req: PartnerRequest, @Param('eventId') eventId: string): Promise<ApiResponse> {
    return { data: await this.partner.restoreEvent(req.partner, eventId) };
  }

  @Get('events/:eventId/gallery')
  @RequirePartnerScopes('events:read')
  async getGallery(@Req() req: PartnerRequest, @Param('eventId') eventId: string): Promise<ApiResponse> {
    return { data: await this.partner.getGalleryConfig(req.partner, eventId) };
  }

  @Patch('events/:eventId/gallery')
  @RequirePartnerScopes('events:write')
  async updateGallery(@Req() req: PartnerRequest, @Param('eventId') eventId: string, @Body() dto: PartnerGalleryConfigDto): Promise<ApiResponse> {
    return { data: await this.partner.updateGalleryConfig(req.partner, eventId, dto) };
  }

  @Get('events/:eventId/bibs/low-confidence')
  @RequirePartnerScopes('photos:review')
  async lowConfidence(@Req() req: PartnerRequest, @Param('eventId') eventId: string, @Query() query: PartnerLowConfidenceQueryDto): Promise<ApiResponse> {
    const result = await this.partner.lowConfidenceBibs(req.partner, eventId, query.threshold, query.page, query.limit);
    return { data: result.items, meta: { pagination: result.pagination } };
  }

  @Get('events/:eventId/contributors')
  @RequirePartnerScopes('events:contributors')
  async contributors(@Req() req: PartnerRequest, @Param('eventId') eventId: string): Promise<ApiResponse> {
    return { data: await this.partner.listContributors(req.partner, eventId) };
  }

  @Post('events/:eventId/contributors/invitations')
  @RequirePartnerScopes('events:contributors')
  async inviteContributor(@Req() req: PartnerRequest, @Param('eventId') eventId: string, @Body() dto: InviteContributorDto): Promise<ApiResponse> {
    return { data: await this.partner.inviteContributor(req.partner, eventId, dto) };
  }

  @Delete('events/:eventId/contributors/:contributorId')
  @RequirePartnerScopes('events:contributors')
  async revokeContributor(@Req() req: PartnerRequest, @Param('eventId') eventId: string, @Param('contributorId') contributorId: string): Promise<ApiResponse> {
    return { data: await this.partner.revokeContributor(req.partner, eventId, contributorId) };
  }

  @Delete('events/:eventId')
  @RequirePartnerScopes('events:write')
  async removeEvent(@Req() req: PartnerRequest, @Param('eventId') eventId: string): Promise<ApiResponse> {
    return { data: await this.partner.removeEvent(req.partner, eventId) };
  }

  @Post('events/:eventId/upload-batches')
  @RequirePartnerScopes('photos:upload')
  async createUploadBatch(
    @Req() req: PartnerRequest,
    @Param('eventId') eventId: string,
    @Body() dto: CreatePartnerUploadBatchDto,
    @Headers('idempotency-key') key: string,
  ): Promise<ApiResponse> {
    return { data: await this.partner.createUploadBatch(req.partner, eventId, dto.totalFiles, key) };
  }

  @Get('events/:eventId/upload-batches')
  @RequirePartnerScopes('photos:read')
  async listUploadBatches(@Req() req: PartnerRequest, @Param('eventId') eventId: string, @Query() query: PartnerListQueryDto): Promise<ApiResponse> {
    const result = await this.partner.listBatches(req.partner, eventId, query);
    return { data: result.items, meta: { pagination: result.pagination } };
  }

  @Post('upload-batches/:batchId/files')
  @RequirePartnerScopes('photos:upload')
  @Throttle(300, 60)
  async presignFiles(
    @Req() req: PartnerRequest,
    @Param('batchId') batchId: string,
    @Body() dto: PresignBatchDto,
  ): Promise<ApiResponse> {
    return { data: await this.partner.presignFiles(req.partner, batchId, dto) };
  }

  @Post('upload-batches/:batchId/complete')
  @RequirePartnerScopes('photos:upload')
  @Throttle(300, 60)
  async completeFiles(
    @Req() req: PartnerRequest,
    @Param('batchId') batchId: string,
    @Body() dto: CompleteBatchDto,
  ): Promise<ApiResponse> {
    return { data: await this.partner.completeFiles(req.partner, batchId, dto) };
  }

  @Get('upload-batches/:batchId')
  @RequirePartnerScopes('photos:read')
  async getBatch(@Req() req: PartnerRequest, @Param('batchId') batchId: string): Promise<ApiResponse> {
    return { data: await this.partner.getBatch(req.partner, batchId) };
  }

  @Get('events/:eventId/photos')
  @RequirePartnerScopes('photos:read')
  async listPhotos(
    @Req() req: PartnerRequest,
    @Param('eventId') eventId: string,
    @Query() query: PartnerListQueryDto,
  ): Promise<ApiResponse> {
    const result = await this.partner.listPhotos(req.partner, eventId, query);
    return { data: result.items, meta: { pagination: result.pagination, ...result.stats } };
  }

  @Get('photos/:photoId')
  @RequirePartnerScopes('photos:read')
  async getPhoto(@Req() req: PartnerRequest, @Param('photoId') photoId: string): Promise<ApiResponse> {
    return { data: await this.partner.getPhoto(req.partner, photoId) };
  }

  @Get('photos/:photoId/assets')
  @RequirePartnerScopes('photos:read')
  async getPhotoAssets(@Req() req: PartnerRequest, @Param('photoId') photoId: string): Promise<ApiResponse> {
    return { data: await this.partner.getPhotoAssets(req.partner, photoId) };
  }

  @Post('photos/:photoId/process')
  @RequirePartnerScopes('photos:process')
  async processPhoto(@Req() req: PartnerRequest, @Param('photoId') photoId: string): Promise<ApiResponse> {
    return { data: await this.partner.processPhoto(req.partner, photoId) };
  }

  @Post('photos/:photoId/bibs')
  @RequirePartnerScopes('photos:review')
  async addBib(@Req() req: PartnerRequest, @Param('photoId') photoId: string, @Body() dto: AddBibDto): Promise<ApiResponse> {
    return { data: await this.partner.addBib(req.partner, photoId, dto) };
  }

  @Delete('photos/:photoId/bibs/:bibId')
  @RequirePartnerScopes('photos:review')
  async removeBib(@Req() req: PartnerRequest, @Param('photoId') photoId: string, @Param('bibId') bibId: string): Promise<ApiResponse> {
    return { data: await this.partner.removeBib(req.partner, photoId, bibId) };
  }

  @Patch('events/:eventId/photos/:photoId/review')
  @RequirePartnerScopes('photos:review')
  async reviewPhoto(@Req() req: PartnerRequest, @Param('eventId') eventId: string, @Param('photoId') photoId: string, @Body() dto: ReviewPhotoDto): Promise<ApiResponse> {
    return { data: await this.partner.reviewPhoto(req.partner, eventId, photoId, dto) };
  }

  @Delete('photos/:photoId')
  @RequirePartnerScopes('photos:delete')
  async deletePhoto(@Req() req: PartnerRequest, @Param('photoId') photoId: string): Promise<ApiResponse> {
    return { data: await this.partner.deletePhoto(req.partner, photoId) };
  }

  @Post('photos/:photoId/download-url')
  @RequirePartnerScopes('photos:download')
  @Throttle(120, 60)
  async downloadPhoto(@Req() req: PartnerRequest, @Param('photoId') photoId: string, @Body() dto: PartnerDownloadDto): Promise<ApiResponse> {
    return { data: await this.partner.downloadPhoto(req.partner, photoId, dto.expiresIn) };
  }

  @Post('events/:eventId/photos/:photoId/download-free')
  @RequirePartnerScopes('photos:download')
  @Throttle(120, 60)
  async freeDownload(@Req() req: PartnerRequest, @Param('eventId') eventId: string, @Param('photoId') photoId: string, @Body() dto: PartnerFreeDownloadDto): Promise<ApiResponse> {
    return { data: await this.partner.freeDownloadPhoto(req.partner, eventId, photoId, dto, req as any) };
  }

  @Post('events/:eventId/photos/bulk/review')
  @RequirePartnerScopes('photos:bulk', 'photos:review')
  async bulkReview(@Req() req: PartnerRequest, @Param('eventId') eventId: string, @Body() dto: PartnerBulkReviewDto): Promise<ApiResponse> {
    return { data: await this.partner.bulkReview(req.partner, eventId, dto.photoIds, dto.status, dto.note) };
  }

  @Post('events/:eventId/photos/bulk/process')
  @RequirePartnerScopes('photos:bulk', 'photos:process')
  async bulkProcess(@Req() req: PartnerRequest, @Param('eventId') eventId: string, @Body() dto: PartnerBulkPhotoIdsDto): Promise<ApiResponse> {
    return { data: await this.partner.bulkProcess(req.partner, eventId, dto.photoIds) };
  }

  @Post('events/:eventId/photos/bulk/delete')
  @RequirePartnerScopes('photos:bulk', 'photos:delete')
  async bulkDelete(@Req() req: PartnerRequest, @Param('eventId') eventId: string, @Body() dto: PartnerBulkPhotoIdsDto): Promise<ApiResponse> {
    return { data: await this.partner.bulkDelete(req.partner, eventId, dto.photoIds) };
  }

  @Post('events/:eventId/photos/bulk/download-urls')
  @RequirePartnerScopes('photos:bulk', 'photos:download')
  async bulkDownload(@Req() req: PartnerRequest, @Param('eventId') eventId: string, @Body() dto: PartnerBulkDownloadDto): Promise<ApiResponse> {
    return { data: await this.partner.bulkDownload(req.partner, eventId, dto.photoIds, dto.expiresIn) };
  }

  @Get('events/:eventId/analytics')
  @RequirePartnerScopes('events:analytics')
  async analytics(@Req() req: PartnerRequest, @Param('eventId') eventId: string): Promise<ApiResponse> {
    return { data: await this.partner.eventAnalytics(req.partner, eventId) };
  }

  @Get('events/:eventId/exports/photos')
  @RequirePartnerScopes('exports:read')
  async exportPhotos(@Req() req: PartnerRequest, @Param('eventId') eventId: string): Promise<ApiResponse> {
    return { data: await this.partner.exportPhotos(req.partner, eventId) };
  }

  @Get('events/:eventId/exports/audience')
  @RequirePartnerScopes('exports:read')
  async exportAudience(@Req() req: PartnerRequest, @Param('eventId') eventId: string): Promise<ApiResponse> {
    return { data: await this.partner.exportAudience(req.partner, eventId) };
  }

  @Get('sponsors')
  @RequirePartnerScopes('events:sponsors')
  async listSponsors(@Req() req: PartnerRequest): Promise<ApiResponse> { return { data: await this.partner.listSponsors(req.partner) }; }

  @Post('sponsors')
  @RequirePartnerScopes('events:sponsors')
  async createSponsor(@Req() req: PartnerRequest, @Body() dto: CreateSponsorDto): Promise<ApiResponse> { return { data: await this.partner.createSponsor(req.partner, dto) }; }

  @Patch('sponsors/:sponsorId')
  @RequirePartnerScopes('events:sponsors')
  async updateSponsor(@Req() req: PartnerRequest, @Param('sponsorId') sponsorId: string, @Body() dto: UpdateSponsorDto): Promise<ApiResponse> { return { data: await this.partner.updateSponsor(req.partner, sponsorId, dto) }; }

  @Delete('sponsors/:sponsorId')
  @RequirePartnerScopes('events:sponsors')
  async removeSponsor(@Req() req: PartnerRequest, @Param('sponsorId') sponsorId: string): Promise<ApiResponse> { return { data: await this.partner.removeSponsor(req.partner, sponsorId) }; }

  @Get('events/:eventId/sponsors')
  @RequirePartnerScopes('events:sponsors')
  async eventSponsors(@Req() req: PartnerRequest, @Param('eventId') eventId: string): Promise<ApiResponse> { return { data: await this.partner.listEventSponsors(req.partner, eventId) }; }

  @Post('events/:eventId/sponsors')
  @RequirePartnerScopes('events:sponsors')
  async attachSponsor(@Req() req: PartnerRequest, @Param('eventId') eventId: string, @Body() dto: AttachEventSponsorDto): Promise<ApiResponse> { return { data: await this.partner.attachSponsor(req.partner, eventId, dto) }; }

  @Delete('events/:eventId/sponsors/:sponsorId')
  @RequirePartnerScopes('events:sponsors')
  async detachSponsor(@Req() req: PartnerRequest, @Param('eventId') eventId: string, @Param('sponsorId') sponsorId: string): Promise<ApiResponse> { return { data: await this.partner.detachSponsor(req.partner, eventId, sponsorId) }; }

  @Get('workspace')
  @RequirePartnerScopes('workspace:read')
  async workspace(@Req() req: PartnerRequest): Promise<ApiResponse> { return { data: await this.partner.getWorkspace(req.partner) }; }

  @Patch('workspace')
  @RequirePartnerScopes('workspace:write')
  async updateWorkspace(@Req() req: PartnerRequest, @Body() dto: UpdateWorkspaceDto): Promise<ApiResponse> { return { data: await this.partner.updateWorkspace(req.partner, dto) }; }

  @Post('workspace/assets/:kind')
  @RequirePartnerScopes('workspace:write')
  @UseInterceptors(FileInterceptor('image', { limits: { fileSize: 5 * 1024 * 1024, files: 1 } }))
  async uploadWorkspaceAsset(@Req() req: PartnerRequest, @Param('kind') kind: string, @UploadedFile() file: Express.Multer.File): Promise<ApiResponse> {
    if (!['logo', 'cover'].includes(kind) || !file) throw new BadRequestException('kind debe ser logo o cover y se requiere image');
    return { data: await this.partner.uploadWorkspaceAsset(req.partner, kind as 'logo' | 'cover', file) };
  }

  @Delete('workspace/assets/:kind')
  @RequirePartnerScopes('workspace:write')
  async removeWorkspaceAsset(@Req() req: PartnerRequest, @Param('kind') kind: string): Promise<ApiResponse> {
    if (!['logo', 'cover'].includes(kind)) throw new BadRequestException('kind debe ser logo o cover');
    return { data: await this.partner.removeWorkspaceAsset(req.partner, kind as 'logo' | 'cover') };
  }

  @Post('workspace/domain/verify')
  @RequirePartnerScopes('workspace:write')
  async verifyWorkspaceDomain(@Req() req: PartnerRequest): Promise<ApiResponse> {
    return { data: await this.partner.verifyWorkspaceDomain(req.partner) };
  }

  @Get('events/:eventId/search/bib')
  @RequirePartnerScopes('search:bib')
  async searchByBib(@Req() req: PartnerRequest, @Param('eventId') eventId: string, @Query() query: PartnerBibSearchQueryDto): Promise<ApiResponse> {
    const result = await this.partner.searchByBib(req.partner, eventId, query.bib, query.limit, query.cursor);
    return { data: result.items, meta: { total: result.total, cursor: result.nextCursor } };
  }

  @Post('events/:eventId/search/face')
  @RequirePartnerScopes('search:face')
  @Throttle(30, 60)
  async searchByFace(@Req() req: PartnerRequest, @Param('eventId') eventId: string, @Body() dto: PartnerFaceSearchDto): Promise<ApiResponse> {
    const result = await this.partner.searchByFace(req.partner, eventId, dto);
    return { data: result, meta: { total: result.total, searchTime: result.searchTime } };
  }

  @Get('events/:eventId/search/face/stats')
  @RequirePartnerScopes('search:face')
  async getFaceStats(@Req() req: PartnerRequest, @Param('eventId') eventId: string): Promise<ApiResponse> {
    return { data: await this.partner.getFaceStats(req.partner, eventId) };
  }

  @Get('webhooks')
  @RequirePartnerScopes('webhooks:manage')
  async listWebhooks(@Req() req: PartnerRequest): Promise<ApiResponse> {
    return { data: await this.webhooks.list(req.partner) };
  }

  @Post('webhooks')
  @RequirePartnerScopes('webhooks:manage')
  async createWebhook(@Req() req: PartnerRequest, @Body() dto: CreatePartnerWebhookDto): Promise<ApiResponse> {
    return { data: await this.webhooks.create(req.partner, dto) };
  }

  @Patch('webhooks/:endpointId')
  @RequirePartnerScopes('webhooks:manage')
  async updateWebhook(@Req() req: PartnerRequest, @Param('endpointId') endpointId: string, @Body() dto: UpdatePartnerWebhookDto): Promise<ApiResponse> {
    return { data: await this.webhooks.update(req.partner, endpointId, dto) };
  }

  @Delete('webhooks/:endpointId')
  @RequirePartnerScopes('webhooks:manage')
  async deleteWebhook(@Req() req: PartnerRequest, @Param('endpointId') endpointId: string): Promise<ApiResponse> {
    return { data: await this.webhooks.remove(req.partner, endpointId) };
  }

  @Post('webhooks/:endpointId/rotate-secret')
  @RequirePartnerScopes('webhooks:manage')
  async rotateWebhookSecret(@Req() req: PartnerRequest, @Param('endpointId') endpointId: string): Promise<ApiResponse> {
    return { data: await this.webhooks.rotateSecret(req.partner, endpointId) };
  }

  @Get('webhooks/:endpointId/deliveries')
  @RequirePartnerScopes('webhooks:manage')
  async listWebhookDeliveries(@Req() req: PartnerRequest, @Param('endpointId') endpointId: string): Promise<ApiResponse> {
    return { data: await this.webhooks.deliveries(req.partner, endpointId) };
  }

  @Post('webhooks/deliveries/:deliveryId/retry')
  @RequirePartnerScopes('webhooks:manage')
  async retryWebhook(@Req() req: PartnerRequest, @Param('deliveryId') deliveryId: string): Promise<ApiResponse> {
    return { data: await this.webhooks.retry(req.partner, deliveryId) };
  }
}
