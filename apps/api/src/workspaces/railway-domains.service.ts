import { BadGatewayException, ConflictException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

export type RailwayDnsRecord = {
  type: 'CNAME' | 'TXT';
  name: string;
  value: string;
  status: string;
  currentValue?: string | null;
};

export type CustomDomainSetup = {
  provider: 'RAILWAY';
  providerId: string;
  domain: string;
  state: 'PENDING_DNS' | 'PENDING_CERTIFICATE' | 'ACTIVE' | 'FAILED';
  certificateStatus: string;
  dnsRecords: RailwayDnsRecord[];
};

type RailwayDomain = {
  id: string;
  domain: string;
  targetPort?: number | null;
  status?: {
    verificationToken?: string | null;
    certificateStatus?: string | null;
    dnsRecords?: Array<{
      hostlabel?: string | null;
      requiredValue?: string | null;
      currentValue?: string | null;
      status?: string | null;
    }> | null;
  } | null;
};

@Injectable()
export class RailwayDomainsService {
  private readonly endpoint = 'https://backboard.railway.com/graphql/v2';

  constructor(private readonly config: ConfigService) {}

  async ensure(domain: string): Promise<CustomDomainSetup> {
    const existing = await this.find(domain);
    const targetPort = this.targetPort();
    if (existing) {
      if (existing.targetPort !== targetPort) {
        await this.graphql<{ customDomainUpdate: boolean }>(
          `mutation customDomainUpdate($environmentId: String!, $id: String!, $targetPort: Int) {
            customDomainUpdate(environmentId: $environmentId, id: $id, targetPort: $targetPort)
          }`,
          {
            environmentId: this.required('RAILWAY_ENVIRONMENT_ID'),
            id: existing.id,
            targetPort,
          },
        );
        existing.targetPort = targetPort;
      }
      return this.toSetup(existing);
    }

    const availability = await this.graphql<{ customDomainAvailable: { available: boolean; message?: string } }>(
      `query customDomainAvailable($domain: String!) {
        customDomainAvailable(domain: $domain) { available message }
      }`,
      { domain },
    );
    if (!availability.customDomainAvailable.available) {
      throw new ConflictException(availability.customDomainAvailable.message || 'Railway no permite registrar este dominio');
    }

    const input: Record<string, string | number> = {
      projectId: this.required('RAILWAY_PROJECT_ID'),
      environmentId: this.required('RAILWAY_ENVIRONMENT_ID'),
      serviceId: this.required('RAILWAY_FRONTEND_SERVICE_ID'),
      domain,
    };
    input.targetPort = targetPort;

    const created = await this.graphql<{ customDomainCreate: RailwayDomain }>(
      `mutation customDomainCreate($input: CustomDomainCreateInput!) {
        customDomainCreate(input: $input) {
          id domain
          status { verificationToken certificateStatus dnsRecords { hostlabel requiredValue currentValue status } }
        }
      }`,
      { input },
    );
    // Railway puede tardar unos instantes en completar los registros; el dato
    // de creación ya contiene lo necesario y las consultas posteriores lo refrescan.
    return this.toSetup(created.customDomainCreate);
  }

  async status(domain: string): Promise<CustomDomainSetup | null> {
    const found = await this.find(domain);
    if (!found) return null;
    const result = await this.graphql<{ customDomain: RailwayDomain }>(
      `query customDomain($id: String!, $projectId: String!) {
        customDomain(id: $id, projectId: $projectId) {
          id domain
          status { verificationToken certificateStatus dnsRecords { hostlabel requiredValue currentValue status } }
        }
      }`,
      { id: found.id, projectId: this.required('RAILWAY_PROJECT_ID') },
    );
    return this.toSetup(result.customDomain);
  }

  async remove(domain: string): Promise<void> {
    const found = await this.find(domain);
    if (!found) return;
    await this.graphql<{ customDomainDelete: boolean }>(
      `mutation customDomainDelete($id: String!) { customDomainDelete(id: $id) }`,
      { id: found.id },
    );
  }

  private async find(domain: string): Promise<RailwayDomain | null> {
    const result = await this.graphql<{ domains: { customDomains: RailwayDomain[] } }>(
      `query domains($projectId: String!, $environmentId: String!, $serviceId: String!) {
        domains(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId) {
          customDomains { id domain targetPort status { verificationToken certificateStatus dnsRecords { hostlabel requiredValue currentValue status } } }
        }
      }`,
      {
        projectId: this.required('RAILWAY_PROJECT_ID'),
        environmentId: this.required('RAILWAY_ENVIRONMENT_ID'),
        serviceId: this.required('RAILWAY_FRONTEND_SERVICE_ID'),
      },
    );
    return result.domains.customDomains.find(item => item.domain.toLowerCase() === domain.toLowerCase()) || null;
  }

  private toSetup(item: RailwayDomain): CustomDomainSetup {
    const status = item.status || {};
    const records: RailwayDnsRecord[] = (status.dnsRecords || [])
      .filter(record => record.hostlabel && record.requiredValue)
      .map(record => ({
        type: 'CNAME',
        name: String(record.hostlabel),
        value: String(record.requiredValue),
        status: String(record.status || 'PENDING'),
        currentValue: record.currentValue,
      }));
    if (status.verificationToken) {
      const token = status.verificationToken.startsWith('railway-verify=')
        ? status.verificationToken
        : `railway-verify=${status.verificationToken}`;
      records.push({ type: 'TXT', name: `_railway-verify.${item.domain}`, value: token, status: 'PENDING' });
    }
    const certificateStatus = String(status.certificateStatus || 'PENDING').toUpperCase();
    const certificateValid = [
      'ISSUED',
      'VALID',
      'CERTIFICATE_STATUS_VALID',
      'CERTIFICATE_STATUS_TYPE_VALID',
    ].includes(certificateStatus);
    const certificateFailed = [
      'FAILED',
      'CERTIFICATE_STATUS_FAILED',
      'CERTIFICATE_STATUS_TYPE_FAILED',
    ].includes(certificateStatus);
    const dnsValid = records.length > 0 && records.filter(record => record.type === 'CNAME').every(record => this.isDnsValid(record.status));
    const state: CustomDomainSetup['state'] = certificateFailed
      ? 'FAILED'
      : certificateValid && dnsValid
        ? 'ACTIVE'
        : dnsValid
          ? 'PENDING_CERTIFICATE'
          : 'PENDING_DNS';
    return { provider: 'RAILWAY', providerId: item.id, domain: item.domain, state, certificateStatus, dnsRecords: records };
  }

  private isDnsValid(status: string) {
    const normalized = status.toUpperCase();
    return normalized === 'VALID' || normalized === 'DNS_RECORD_STATUS_PROPAGATED';
  }

  private required(name: string) {
    const value = this.config.get<string>(name)?.trim();
    if (!value) throw new ServiceUnavailableException('La integración de dominios personalizados no está configurada');
    return value;
  }

  private targetPort() {
    const value = Number(this.required('RAILWAY_FRONTEND_PORT'));
    if (!Number.isInteger(value) || value < 1 || value > 65_535) {
      throw new ServiceUnavailableException('El puerto del frontend para dominios personalizados no es válido');
    }
    return value;
  }

  private async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const token = this.required('RAILWAY_API_TOKEN');
    try {
      const response = await axios.post(this.endpoint, { query, variables }, {
        timeout: 15_000,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      });
      if (response.data?.errors?.length) {
        const first = response.data.errors[0];
        throw new BadGatewayException({
          code: 'RAILWAY_DOMAIN_ERROR',
          message: first.message || 'Railway rechazó la operación del dominio',
          traceId: first.extensions?.traceId,
        });
      }
      if (!response.data?.data) throw new BadGatewayException('Railway devolvió una respuesta vacía');
      return response.data.data as T;
    } catch (error) {
      if (error instanceof BadGatewayException || error instanceof ConflictException || error instanceof ServiceUnavailableException) throw error;
      if (axios.isAxiosError(error) && error.response?.status === 429) {
        throw new ServiceUnavailableException('Railway limitó temporalmente las consultas; inténtalo de nuevo en unos minutos');
      }
      throw new BadGatewayException('No se pudo comunicar con Railway para configurar el dominio');
    }
  }
}
