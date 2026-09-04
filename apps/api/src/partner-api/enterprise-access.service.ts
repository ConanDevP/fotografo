import { ForbiddenException, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { PrismaService } from '../common/services/prisma.service';
import { PARTNER_API_SCOPES, PartnerApiScope } from './partner-api.scopes';

const FEATURE_SCOPES: Partial<Record<PartnerApiScope, string>> = {
  'webhooks:manage': 'webhooksEnabled', 'search:face': 'faceSearchEnabled',
  'events:sponsors': 'sponsorsEnabled', 'exports:read': 'exportsEnabled',
  'photos:download': 'originalDownloadsEnabled', 'events:analytics': 'advancedAnalyticsEnabled',
};

@Injectable()
export class EnterpriseAccessService {
  constructor(private readonly prisma: PrismaService) {}

  async account(workspaceId: string) {
    return this.prisma.enterpriseAccount.findUnique({ where: { workspaceId } });
  }

  async dashboard(workspaceId: string) {
    const account = await this.account(workspaceId);
    const period = new Date().toISOString().slice(0, 7);
    const [usage, apiClients, webhookEndpoints] = await Promise.all([
      this.prisma.partnerApiUsage.findUnique({ where: { workspaceId_period: { workspaceId, period } } }),
      this.prisma.apiClient.count({ where: { workspaceId, revokedAt: null } }),
      this.prisma.partnerWebhookEndpoint.count({ where: { workspaceId, active: true } }),
    ]);
    const legacy = !account && apiClients > 0;
    const active = this.isActive(account);
    const enabled = Boolean(active && account?.partnerApiEnabled);
    const permittedScopes = enabled ? PARTNER_API_SCOPES.filter(scope => {
      const feature = FEATURE_SCOPES[scope];
      return !feature || Boolean((account as any)[feature]);
    }) : [];
    return {
      tier: account ? 'ENTERPRISE' : legacy ? 'LEGACY' : 'STANDARD',
      status: account?.status || (legacy ? 'LEGACY' : 'NOT_CONTRACTED'),
      active,
      contractStart: account?.contractStart || null,
      contractEnd: account?.contractEnd || null,
      features: {
        partnerApi: enabled, webhooks: Boolean(active && account?.webhooksEnabled),
        faceSearch: Boolean(active && account?.faceSearchEnabled), sponsors: Boolean(active && account?.sponsorsEnabled),
        customDomain: Boolean(active && account?.customDomainEnabled), advancedAnalytics: Boolean(active && account?.advancedAnalyticsEnabled),
        exports: Boolean(active && account?.exportsEnabled), originalDownloads: Boolean(active && account?.originalDownloadsEnabled),
        sponsoredDownloads: Boolean(active && account?.sponsoredDownloadsEnabled), priorityProcessing: Boolean(active && account?.priorityProcessingEnabled),
      },
      limits: {
        monthlyApiRequests: account?.monthlyApiRequestLimit ?? null, monthlyFaceSearches: account?.monthlyFaceSearchLimit ?? null,
        annualPhotos: account?.annualPhotoLimit ?? null, annualEvents: account?.annualEventLimit ?? null,
        maxApiClients: account?.maxApiClients ?? null, maxWebhookEndpoints: account?.maxWebhookEndpoints ?? null,
        maxAdmins: account?.maxAdmins ?? null, retentionDays: account?.retentionDays ?? null,
      },
      usage: { period, apiRequests: Number(usage?.requestCount || 0n), faceSearches: Number(usage?.faceSearchCount || 0n), apiClients, webhookEndpoints },
      permittedScopes,
    };
  }

  isActive(account: any, now = new Date()) {
    return !!account && ['PILOT', 'ACTIVE'].includes(account.status)
      && (!account.contractStart || account.contractStart <= now)
      && (!account.contractEnd || account.contractEnd > now);
  }

  async assertCanCreateClient(workspaceId: string, scopes: PartnerApiScope[]) {
    const account = await this.account(workspaceId);
    if (!this.isActive(account) || !account!.partnerApiEnabled) {
      throw new ForbiddenException('La API empresarial no está habilitada para este workspace');
    }
    await this.assertScopes(account, scopes);
    if (account!.maxApiClients != null) {
      const count = await this.prisma.apiClient.count({ where: { workspaceId, revokedAt: null } });
      if (count >= account!.maxApiClients) throw new ForbiddenException('Se alcanzó el límite de credenciales API activas');
    }
  }

  async assertCanRotateClient(workspaceId: string, scopes: PartnerApiScope[]) {
    const account = await this.account(workspaceId);
    if (!this.isActive(account) || !account!.partnerApiEnabled) throw new ForbiddenException('La API empresarial no está habilitada para este workspace');
    await this.assertScopes(account, scopes);
  }

  async authorizeExistingClient(workspaceId: string, scopes: PartnerApiScope[], required: PartnerApiScope[]) {
    const account = await this.account(workspaceId);
    if (!account) return; // Compatibilidad exclusiva para credenciales emitidas antes del control Enterprise.
    if (!this.isActive(account) || !account.partnerApiEnabled) throw new ForbiddenException('Acceso API empresarial suspendido o vencido');
    await this.assertScopes(account, [...scopes, ...required]);
    await this.reserveRequest(workspaceId, account.monthlyApiRequestLimit, required.includes('search:face') ? account.monthlyFaceSearchLimit : null);
  }

  async assertCanCreateWebhook(workspaceId: string) {
    const account = await this.account(workspaceId);
    if (!account) return;
    if (!this.isActive(account) || !account.webhooksEnabled) throw new ForbiddenException('Los webhooks no están habilitados en el contrato');
    if (account.maxWebhookEndpoints != null) {
      const count = await this.prisma.partnerWebhookEndpoint.count({ where: { workspaceId } });
      if (count >= account.maxWebhookEndpoints) throw new ForbiddenException('Se alcanzó el límite de endpoints webhook');
    }
  }

  private async assertScopes(account: any, scopes: PartnerApiScope[]) {
    const disabled = [...new Set(scopes)].filter(scope => {
      const feature = FEATURE_SCOPES[scope];
      return feature && !account[feature];
    });
    if (disabled.length) throw new ForbiddenException(`El contrato no habilita estos permisos: ${disabled.join(', ')}`);
  }

  private async reserveRequest(workspaceId: string, limit: number | null, faceLimit: number | null) {
    if (limit == null && faceLimit == null) return;
    const period = new Date().toISOString().slice(0, 7);
    const faceIncrement = faceLimit == null ? 0 : 1;
    const rows = await this.prisma.$queryRaw<Array<{ request_count: bigint, face_search_count: bigint }>>`
      INSERT INTO "partner_api_usage" ("workspace_id", "period", "request_count", "face_search_count", "updated_at")
      VALUES (${workspaceId}::uuid, ${period}, 1, ${faceIncrement}, NOW())
      ON CONFLICT ("workspace_id", "period") DO UPDATE
      SET "request_count" = "partner_api_usage"."request_count" + 1,
          "face_search_count" = "partner_api_usage"."face_search_count" + ${faceIncrement}, "updated_at" = NOW()
      RETURNING "request_count", "face_search_count"`;
    if (limit != null && rows[0].request_count > BigInt(limit)) throw new HttpException('Cuota mensual de solicitudes API agotada', HttpStatus.TOO_MANY_REQUESTS);
    if (faceLimit != null && rows[0].face_search_count > BigInt(faceLimit)) throw new HttpException('Cuota mensual de búsquedas faciales agotada', HttpStatus.TOO_MANY_REQUESTS);
  }
}
