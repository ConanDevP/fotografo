export const PARTNER_WEBHOOK_EVENTS = [
  'event.created', 'event.updated', 'event.deleted', 'event.restored',
  'event.cover.updated', 'event.cover.removed', 'event.gallery.updated',
  'event.contributor.invited', 'event.contributor.revoked',
  'event.sponsor.attached', 'event.sponsor.detached',
  'upload.batch.created', 'upload.batch.completed', 'upload.batch.failed',
  'photo.processing.completed', 'photo.processing.failed',
  'photo.deleted', 'photo.reviewed', 'photo.download_url.created', 'photo.free_downloaded',
  'photo.bulk.completed', 'workspace.brand.updated',
] as const;

export type PartnerWebhookEvent = typeof PARTNER_WEBHOOK_EVENTS[number];
