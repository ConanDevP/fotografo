import {
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../common/services/prisma.service';
import { MailerService } from '../common/services/mailer.service';
import { PARTNER_API_SCOPES, PartnerApiScope } from './partner-api.scopes';
import { RequestEnterpriseAccessDto } from './dto/request-enterprise-access.dto';

const FEATURE_SCOPES: Partial<Record<PartnerApiScope, string>> = {
  'webhooks:manage': 'webhooksEnabled', 'search:face': 'faceSearchEnabled',
  'events:sponsors': 'sponsorsEnabled', 'exports:read': 'exportsEnabled',
  'photos:download': 'originalDownloadsEnabled', 'events:analytics': 'advancedAnalyticsEnabled',
};

@Injectable()
export class EnterpriseAccessService {
  private readonly logger = new Logger(EnterpriseAccessService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    // Opcional: el worker también usa este servicio (guards/cuotas) y no provee
    // MailerService. Sin correo, la solicitud igual queda registrada.
    @Optional() private readonly mailer?: MailerService,
  ) {}

  async account(workspaceId: string) {
    return this.prisma.enterpriseAccount.findUnique({ where: { workspaceId } });
  }

  /**
   * Solicitud de acceso a la API empresarial desde el dashboard del fotógrafo.
   *
   * No concede nada: crea (o actualiza) la cuenta Enterprise en estado PROSPECT
   * con el contexto de la solicitud en `internalNotes`, deja rastro en auditoría
   * y avisa al equipo comercial. El admin la revisa en /admin/enterprise y la
   * pasa a PILOT/ACTIVE con las funcionalidades y topes acordados.
   */
  async requestAccess(
    workspaceId: string,
    requesterId: string,
    requesterEmail: string,
    dto: RequestEnterpriseAccessDto,
  ) {
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { id: true, name: true, slug: true },
    });
    if (!workspace) throw new NotFoundException('Workspace no encontrado');

    const account = await this.account(workspaceId);
    if (account && ['PILOT', 'ACTIVE'].includes(account.status) && account.partnerApiEnabled) {
      throw new ConflictException('Este espacio ya tiene acceso a la API empresarial');
    }

    // Anti-spam: una solicitud PROSPECT tocada en las últimas 12 h no se
    // reprocesa ni vuelve a notificar.
    if (
      account?.status === 'PROSPECT' &&
      Date.now() - account.updatedAt.getTime() < 12 * 60 * 60 * 1000
    ) {
      return {
        pending: true,
        alreadyRequested: true,
        status: account.status,
        requestedAt: account.updatedAt.toISOString(),
        contactEmail: account.businessContactEmail ?? requesterEmail,
        message: 'Ya tenemos tu solicitud en revisión.',
      };
    }

    const contactEmail = (dto.contactEmail ?? requesterEmail).toLowerCase();
    const note = [
      `[SOLICITUD ${new Date().toISOString().slice(0, 16).replace('T', ' ')} · ${requesterEmail}]`,
      `Uso: ${dto.useCase.trim()}`,
      dto.monthlyVolume ? `Volumen: ${dto.monthlyVolume.trim()}` : null,
      dto.integrationType ? `Integración: ${dto.integrationType.trim()}` : null,
      `Contacto: ${contactEmail}`,
      dto.message ? `Mensaje: ${dto.message.trim()}` : null,
    ]
      .filter(Boolean)
      .join('\n');

    const saved = await this.prisma.$transaction(async tx => {
      const record = account
        ? await tx.enterpriseAccount.update({
            where: { workspaceId },
            data: {
              // El estado no se toca si ya había un contrato (SUSPENDED/ENDED):
              // que decida el admin. Solo se anota la petición.
              status: account.status === 'PROSPECT' ? 'PROSPECT' : account.status,
              internalNotes: [note, account.internalNotes].filter(Boolean).join('\n\n---\n\n').slice(0, 3000),
              businessContactEmail: account.businessContactEmail ?? contactEmail,
              updatedById: requesterId,
            },
          })
        : await tx.enterpriseAccount.create({
            data: {
              workspaceId,
              status: 'PROSPECT',
              businessContactEmail: contactEmail,
              internalNotes: note,
              createdById: requesterId,
              updatedById: requesterId,
            },
          });
      await tx.auditLog.create({
        data: {
          userId: requesterId,
          action: 'ENTERPRISE_ACCESS_REQUESTED',
          data: {
            workspaceId,
            workspaceName: workspace.name,
            useCase: dto.useCase.slice(0, 200),
            contactEmail,
          },
        },
      });
      return record;
    });

    await this.notifySales(workspace, requesterEmail, contactEmail, note).catch(error =>
      this.logger.warn(`No se pudo avisar a comercial: ${error instanceof Error ? error.message : 'error'}`),
    );

    return {
      pending: true,
      alreadyRequested: false,
      status: saved.status,
      requestedAt: saved.updatedAt.toISOString(),
      contactEmail,
      message: 'Hemos recibido tu solicitud. El equipo te contactará por correo.',
    };
  }

  private async notifySales(
    workspace: { name: string; slug: string },
    requesterEmail: string,
    contactEmail: string,
    note: string,
  ) {
    if (!this.mailer?.isConfigured) return;
    const to = this.config.get<string>('SALES_EMAIL') || this.config.get<string>('EMAIL_FROM');
    if (!to) return;
    const adminBase = (this.config.get<string>('FRONTEND_URL') || this.config.get<string>('APP_URL') || '').replace(/\/$/, '');
    const link = adminBase ? `${adminBase}/admin/enterprise?search=${encodeURIComponent(workspace.slug)}` : '';
    const esc = (v: string) => String(v ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string));
    await this.mailer.send({
      to,
      subject: `Solicitud de API Business — ${workspace.name}`,
      html: `
<div style="font-family:sans-serif;max-width:560px">
  <h2 style="margin:0 0 8px">Nueva solicitud de acceso Business</h2>
  <p style="margin:0 0 4px"><strong>Espacio:</strong> ${esc(workspace.name)} (/${esc(workspace.slug)})</p>
  <p style="margin:0 0 4px"><strong>Solicitante:</strong> ${esc(requesterEmail)}</p>
  <p style="margin:0 0 12px"><strong>Contacto:</strong> ${esc(contactEmail)}</p>
  <pre style="white-space:pre-wrap;background:#f6f6f6;padding:12px;border-radius:8px;font-size:13px">${esc(note)}</pre>
  ${link ? `<p><a href="${esc(link)}">Abrir en /admin/enterprise</a></p>` : ''}
</div>`.trim(),
    });
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
      // Solicitud del fotógrafo pendiente de que comercial la revise.
      requestPending: account?.status === 'PROSPECT',
      requestedAt: account?.status === 'PROSPECT' ? account.updatedAt : null,
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
