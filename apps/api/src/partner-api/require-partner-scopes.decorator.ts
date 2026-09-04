import { SetMetadata } from '@nestjs/common';
import { PartnerApiScope } from './partner-api.scopes';

export const PARTNER_SCOPES_METADATA = 'partner-api-scopes';
export const RequirePartnerScopes = (...scopes: PartnerApiScope[]) =>
  SetMetadata(PARTNER_SCOPES_METADATA, scopes);
