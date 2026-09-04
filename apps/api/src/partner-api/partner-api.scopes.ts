export const PARTNER_API_SCOPES = [
  'events:read',
  'events:write',
  'events:publish',
  'events:analytics',
  'events:contributors',
  'events:sponsors',
  'photos:read',
  'photos:upload',
  'photos:review',
  'photos:process',
  'photos:delete',
  'photos:download',
  'photos:bulk',
  'exports:read',
  'workspace:read',
  'workspace:write',
  'search:bib',
  'search:face',
  'webhooks:manage',
] as const;

export type PartnerApiScope = typeof PARTNER_API_SCOPES[number];
