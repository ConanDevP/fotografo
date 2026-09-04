import { PartnerApiScope } from './partner-api.scopes';

export interface PartnerPrincipal {
  apiClientId: string;
  workspaceId: string;
  actorUserId: string;
  actorRole: string;
  keyPrefix: string;
  scopes: PartnerApiScope[];
}

export interface PartnerRequest {
  partner: PartnerPrincipal;
}
