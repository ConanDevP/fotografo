import axios from 'axios';
import { ConfigService } from '@nestjs/config';
import { RailwayDomainsService } from './railway-domains.service';

describe('RailwayDomainsService', () => {
  const config = new ConfigService({
    RAILWAY_API_TOKEN: 'railway-token-with-enough-length',
    RAILWAY_PROJECT_ID: 'project-id',
    RAILWAY_ENVIRONMENT_ID: 'environment-id',
    RAILWAY_FRONTEND_SERVICE_ID: 'frontend-id',
    RAILWAY_FRONTEND_PORT: '8080',
  });
  const service = new RailwayDomainsService(config);

  afterEach(() => jest.restoreAllMocks());

  it('crea el dominio y devuelve los dos registros necesarios', async () => {
    const post = jest.spyOn(axios, 'post')
      .mockResolvedValueOnce({ data: { data: { domains: { customDomains: [] } } } } as any)
      .mockResolvedValueOnce({ data: { data: { customDomainAvailable: { available: true } } } } as any)
      .mockResolvedValueOnce({ data: { data: { customDomainCreate: {
        id: 'domain-id', domain: 'fotos.cliente.com', status: {
          verificationToken: 'abc123', certificateStatus: 'PENDING',
          dnsRecords: [{ hostlabel: 'fotos', requiredValue: 'target.up.railway.app', status: 'PENDING' }],
        },
      } } } } as any);

    const result = await service.ensure('fotos.cliente.com');

    expect(result.state).toBe('PENDING_DNS');
    expect(result.dnsRecords).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'CNAME', value: 'target.up.railway.app' }),
      expect.objectContaining({ type: 'TXT', name: '_railway-verify.fotos.cliente.com', value: 'railway-verify=abc123' }),
    ]));
    expect(post).toHaveBeenCalledTimes(3);
  });

  it('solo declara activo cuando Railway emitió el certificado y propagó DNS', async () => {
    jest.spyOn(axios, 'post')
      .mockResolvedValueOnce({ data: { data: { domains: { customDomains: [{ id: 'domain-id', domain: 'fotos.cliente.com' }] } } } } as any)
      .mockResolvedValueOnce({ data: { data: { customDomain: {
        id: 'domain-id', domain: 'fotos.cliente.com', status: {
          certificateStatus: 'ISSUED',
          dnsRecords: [{ hostlabel: 'fotos', requiredValue: 'target.up.railway.app', currentValue: 'target.up.railway.app', status: 'VALID' }],
        },
      } } } } as any);

    await expect(service.status('fotos.cliente.com')).resolves.toMatchObject({ state: 'ACTIVE' });
  });

  it('elimina el dominio existente de Railway', async () => {
    const post = jest.spyOn(axios, 'post')
      .mockResolvedValueOnce({ data: { data: { domains: { customDomains: [
        { id: 'domain-id', domain: 'fotos.cliente.com' },
      ] } } } } as any)
      .mockResolvedValueOnce({ data: { data: { customDomainDelete: true } } } as any);

    await service.remove('fotos.cliente.com');

    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[1][1]).toMatchObject({ variables: { id: 'domain-id' } });
  });

  it('desconectar un dominio inexistente es idempotente', async () => {
    const post = jest.spyOn(axios, 'post')
      .mockResolvedValueOnce({ data: { data: { domains: { customDomains: [] } } } } as any);

    await service.remove('fotos.cliente.com');

    expect(post).toHaveBeenCalledTimes(1);
  });

  it('corrige el puerto de un dominio existente', async () => {
    const post = jest.spyOn(axios, 'post')
      .mockResolvedValueOnce({ data: { data: { domains: { customDomains: [{
        id: 'domain-id', domain: 'fotos.cliente.com', targetPort: 3000,
        status: { certificateStatus: 'ISSUED', dnsRecords: [] },
      }] } } } } as any)
      .mockResolvedValueOnce({ data: { data: { customDomainUpdate: true } } } as any);

    await service.ensure('fotos.cliente.com');

    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[1][1]).toMatchObject({
      variables: { environmentId: 'environment-id', id: 'domain-id', targetPort: 8080 },
    });
  });

  it('reconoce el estado válido que Railway devuelve actualmente', async () => {
    jest.spyOn(axios, 'post')
      .mockResolvedValueOnce({ data: { data: { domains: { customDomains: [{ id: 'domain-id', domain: 'fotos.cliente.com' }] } } } } as any)
      .mockResolvedValueOnce({ data: { data: { customDomain: {
        id: 'domain-id', domain: 'fotos.cliente.com', status: {
          certificateStatus: 'CERTIFICATE_STATUS_TYPE_VALID',
          dnsRecords: [{ hostlabel: 'fotos', requiredValue: 'target.up.railway.app', status: 'DNS_RECORD_STATUS_PROPAGATED' }],
        },
      } } } } as any);

    await expect(service.status('fotos.cliente.com')).resolves.toMatchObject({ state: 'ACTIVE' });
  });
});
