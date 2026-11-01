import { BadRequestException, GoneException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { RegistrationsService } from './registrations.service';
import { signUnsubscribeToken } from '@shared/registration';

const SECRET = 'secreto-de-prueba';
const DAY = 24 * 60 * 60 * 1000;

function build(overrides: { event?: any; existing?: any; createError?: Error; config?: Record<string, string> } = {}) {
  const found = overrides.existing ? [overrides.existing] : [];
  const event = {
    id: 'evt-1', name: 'Maratón', date: new Date(Date.now() + DAY), location: 'CDMX', imageUrl: null,
    bibRules: null, countryCode: 'MX', isPublished: false, workspace: { slug: 'ws', name: 'WS' },
    ...overrides.event,
  };
  const prisma: any = {
    event: { findFirst: jest.fn().mockResolvedValue(event) },
    bibSubscription: {
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue(found),
      delete: jest.fn().mockResolvedValue({}),
      create: overrides.createError
        ? jest.fn().mockRejectedValue(overrides.createError)
        : jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'sub-1', ...data })),
      update: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'sub-1', ...data })),
      findUnique: jest.fn(),
    },
    photoBib: { count: jest.fn().mockResolvedValue(0) },
    bibNotificationLog: { findMany: jest.fn().mockResolvedValue([]), createMany: jest.fn().mockResolvedValue({}) },
    $transaction: jest.fn().mockImplementation((ops: any[]) => Promise.all(ops)),
  };
  const config: any = { get: jest.fn((key: string, fallback?: unknown) => ({ REGISTRATION_SECRET: SECRET, WHATSAPP_TOKEN: 't', WHATSAPP_PHONE_ID: 'p', WHATSAPP_TEMPLATE_ES: 'x', ...(overrides.config || {}) }[key] ?? fallback)) };
  const scheduler: any = { scheduleForBibs: jest.fn().mockResolvedValue(1) };
  const service = new RegistrationsService(prisma, config, {} as any, scheduler);
  return { service, prisma, scheduler };
}

describe('RegistrationsService.register', () => {
  const base = { bib: '123', email: 'a@b.co', emailConsent: true };

  it('crea el registro con consentimiento y programa el primer aviso', async () => {
    const { service, prisma, scheduler } = build();
    const result = await service.register('abcd2345', { ...base, locale: 'en' }, '1.2.3.4');

    expect(result).toMatchObject({ registered: true, channels: ['EMAIL'] });
    const data = prisma.bibSubscription.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ eventId: 'evt-1', bib: '123', email: 'a@b.co', source: 'QR', locale: 'en' });
    expect(data.emailConsentAt).toBeInstanceOf(Date);
    expect(data.ipHash).toMatch(/^[0-9a-f]{64}$/);
    expect(data.ipHash).not.toContain('1.2.3.4');
    expect(scheduler.scheduleForBibs).toHaveBeenCalledWith('evt-1', ['123'], 30_000);
  });

  it('guarda el teléfono en E.164 usando el país del evento', async () => {
    const { service, prisma } = build();
    await service.register('abcd2345', { bib: '7', phone: '55 1234 5678', whatsappConsent: true }, 'ip');
    const data = prisma.bibSubscription.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ phone: '+525512345678', phoneCountry: 'MX' });
    expect(data).not.toHaveProperty('email');
    expect(data.whatsappConsentAt).toBeInstanceOf(Date);
  });

  it('el país elegido en el formulario manda sobre el del evento', async () => {
    const { service, prisma } = build();
    await service.register('abcd2345', { bib: '7', phone: '(415) 555-2671', phoneCountry: 'US', whatsappConsent: true }, 'ip');
    expect(prisma.bibSubscription.create.mock.calls[0][0].data.phone).toBe('+14155552671');
  });

  it('no guarda contacto sin el consentimiento de ese canal', async () => {
    const { service, prisma } = build();
    await expect(service.register('abcd2345', { bib: '1', email: 'a@b.co' }, 'ip')).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.register('abcd2345', { bib: '1', phone: '5512345678' }, 'ip')).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.bibSubscription.create).not.toHaveBeenCalled();
  });

  it('no acepta un teléfono si el canal de WhatsApp no está configurado', async () => {
    const { service, prisma } = build({ config: { WHATSAPP_TOKEN: '' } });
    await expect(
      service.register('abcd2345', { bib: '1', phone: '5512345678', whatsappConsent: true }, 'ip'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.bibSubscription.create).not.toHaveBeenCalled();
  });

  it('exige al menos un contacto', async () => {
    const { service } = build();
    await expect(service.register('abcd2345', { bib: '1' }, 'ip')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rechaza un teléfono que no es real', async () => {
    const { service } = build();
    await expect(
      service.register('abcd2345', { bib: '1', phone: '123', whatsappConsent: true }, 'ip'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rechaza un dorsal fuera de las reglas del evento', async () => {
    const { service } = build({ event: { bibRules: { range: [1, 100] } } });
    await expect(service.register('abcd2345', { ...base, bib: '500' }, 'ip')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('un robot que rellena el campo trampa recibe éxito sin que se guarde nada', async () => {
    const { service, prisma } = build();
    const result = await service.register('abcd2345', { ...base, website: 'http://spam' }, 'ip');
    expect(result.registered).toBe(true);
    expect(prisma.bibSubscription.create).not.toHaveBeenCalled();
  });

  it('si ya estaba registrado completa la fila y reactiva a quien se había dado de baja', async () => {
    const { service, prisma } = build({ existing: { id: 'sub-9', status: 'UNSUBSCRIBED' } });
    await service.register('abcd2345', { bib: '123', phone: '5512345678', whatsappConsent: true, email: 'a@b.co', emailConsent: true }, 'ip');
    expect(prisma.bibSubscription.create).not.toHaveBeenCalled();
    expect(prisma.bibSubscription.update.mock.calls[0][0]).toMatchObject({
      where: { id: 'sub-9' },
      data: { status: 'ACTIVE', unsubscribedAt: null, phone: '+525512345678', email: 'a@b.co' },
    });
  });

  it('dos escaneos casi a la vez: el segundo choca, reintenta y completa la fila del primero', async () => {
    const conflict = new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: '5' });
    const { service, prisma } = build();
    prisma.bibSubscription.create.mockRejectedValueOnce(conflict);
    prisma.bibSubscription.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 'sub-2', status: 'ACTIVE' }]);
    const result = await service.register('abcd2345', base, 'ip');
    expect(result.registered).toBe(true);
    expect(prisma.bibSubscription.update.mock.calls[0][0].where).toEqual({ id: 'sub-2' });
  });

  it('si el correo y el teléfono estaban en filas distintas las une y conserva el historial', async () => {
    const { service, prisma } = build();
    prisma.bibSubscription.findMany.mockResolvedValue([
      { id: 'por-correo', status: 'ACTIVE' },
      { id: 'por-telefono', status: 'ACTIVE' },
    ]);
    prisma.bibNotificationLog.findMany.mockResolvedValue([{ photoId: 'p1', channel: 'WHATSAPP', sentAt: new Date(0) }]);
    await service.register('abcd2345', { bib: '123', email: 'a@b.co', emailConsent: true, phone: '5512345678', whatsappConsent: true }, 'ip');

    expect(prisma.bibNotificationLog.createMany.mock.calls[0][0].data).toEqual([
      expect.objectContaining({ subscriptionId: 'por-correo', photoId: 'p1', channel: 'WHATSAPP' }),
    ]);
    expect(prisma.bibSubscription.delete).toHaveBeenCalledWith({ where: { id: 'por-telefono' } });
    expect(prisma.bibSubscription.update.mock.calls[0][0].where).toEqual({ id: 'por-correo' });
  });

  it('frena a una IP que registra a todos', async () => {
    const { service, prisma } = build();
    prisma.bibSubscription.count.mockResolvedValue(60);
    await expect(service.register('abcd2345', base, 'ip')).rejects.toMatchObject({ status: 429 });
  });

  it('el registro está disponible antes de publicar, pero cierra 30 días después de la carrera', async () => {
    const open = build({ event: { isPublished: false } });
    await expect(open.service.getPublic('abcd2345')).resolves.toMatchObject({ name: 'Maratón', defaultCountry: 'MX' });

    const closed = build({ event: { date: new Date(Date.now() - 31 * DAY) } });
    await expect(closed.service.getPublic('abcd2345')).rejects.toBeInstanceOf(GoneException);
  });

  it('un código inexistente o mal formado es 404', async () => {
    const { service, prisma } = build();
    prisma.event.findFirst.mockResolvedValue(null);
    await expect(service.getPublic('abcd2345')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.getPublic('x')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('no avisa de fotos mientras el evento no esté publicado', async () => {
    const { service, prisma } = build({ event: { isPublished: false } });
    prisma.photoBib.count.mockResolvedValue(3);
    expect((await service.register('abcd2345', base, 'ip')).hasPhotos).toBe(false);
  });
});

describe('RegistrationsService baja', () => {
  it('da de baja con un enlace firmado', async () => {
    const { service, prisma } = build();
    prisma.bibSubscription.findUnique.mockResolvedValue({ id: '6f1c1d0e-2b7a-4c53-9a53-0d1f8c9e7a11', status: 'ACTIVE', bib: '1', event: { name: 'X' } });
    const token = signUnsubscribeToken('6f1c1d0e-2b7a-4c53-9a53-0d1f8c9e7a11', SECRET);
    await expect(service.unsubscribe(token)).resolves.toEqual({ unsubscribed: true });
    expect(prisma.bibSubscription.update.mock.calls[0][0].data.status).toBe('UNSUBSCRIBED');
  });

  it('rechaza un enlace alterado', async () => {
    const { service } = build();
    await expect(service.unsubscribe('6f1c1d0e-2b7a-4c53-9a53-0d1f8c9e7a11.mal')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('RegistrationsService.exportCsv', () => {
  it('neutraliza fórmulas y escapa comillas', async () => {
    const { service, prisma } = build();
    (service as any).events = { assertCanManageAudienceData: jest.fn() };
    prisma.bibSubscription.findMany = jest.fn().mockResolvedValue([
      { bib: '1', name: '=HYPERLINK("x")', email: 'a@b.co', phone: null, phoneCountry: null, source: 'QR', status: 'ACTIVE', locale: 'es', emailConsentAt: null, whatsappConsentAt: null, createdAt: new Date(0) },
    ]);
    const csv = await service.exportCsv('evt-1', 'u', 'ADMIN' as any);
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
  });

  it('deja los teléfonos E.164 intactos, sin comilla delante', async () => {
    const { service, prisma } = build();
    (service as any).events = { assertCanManageAudienceData: jest.fn() };
    prisma.bibSubscription.findMany = jest.fn().mockResolvedValue([
      { bib: '1', name: 'Ana', email: null, phone: '+525512345678', phoneCountry: 'MX', source: 'QR', status: 'ACTIVE', locale: 'es', emailConsentAt: null, whatsappConsentAt: null, createdAt: new Date(0) },
    ]);
    const csv = await service.exportCsv('evt-1', 'u', 'ADMIN' as any);
    expect(csv).toContain(',+525512345678,MX,');
    expect(csv).not.toContain("'+52");
  });
});

describe('RegistrationsService: dominio propio en el QR', () => {
  function withEvent(row: any) {
    const { service, prisma } = build();
    (service as any).events = { assertCanAccessEvent: jest.fn(), assertCanManageEvent: jest.fn() };
    prisma.event.findFirstOrThrow = jest.fn().mockResolvedValue({
      registrationCode: 'k7m2p9xq', registrationEnabled: true, registrationUseCustomDomain: false, countryCode: 'MX',
      date: new Date(), workspace: { customDomain: 'fotos.club.com', customDomainVerifiedAt: new Date() }, ...row,
    });
    prisma.event.update = jest.fn().mockResolvedValue({});
    prisma.bibSubscription.count.mockResolvedValue(0);
    return { service, prisma };
  }
  const ADMIN = 'ADMIN' as any;

  it('por defecto el QR usa lucilamon.com y ofrece el dominio propio como alternativa', async () => {
    const { service } = withEvent({});
    const config = await service.getConfig('e', 'u', ADMIN);
    expect(config.url).toBe('http://localhost:3000/r/k7m2p9xq');
    expect(config.customDomainUrl).toBe('https://fotos.club.com/r/k7m2p9xq');
    expect(config.useCustomDomain).toBe(false);
  });

  it('con el dominio propio elegido y verificado, el QR lo usa', async () => {
    const { service } = withEvent({ registrationUseCustomDomain: true });
    const config = await service.getConfig('e', 'u', ADMIN);
    expect(config.url).toBe('https://fotos.club.com/r/k7m2p9xq');
    expect(config.platformUrl).toBe('http://localhost:3000/r/k7m2p9xq');
    expect(config.useCustomDomain).toBe(true);
  });

  it('si el dominio dejó de estar verificado, vuelve a lucilamon.com y lo avisa', async () => {
    const { service } = withEvent({
      registrationUseCustomDomain: true,
      workspace: { customDomain: 'fotos.club.com', customDomainVerifiedAt: null },
    });
    const config = await service.getConfig('e', 'u', ADMIN);
    expect(config.url).toBe('http://localhost:3000/r/k7m2p9xq');
    expect(config.customDomainLapsed).toBe(true);
    expect(config.customDomain).toBeNull();
  });

  it('no deja elegir el dominio propio si el espacio no tiene uno verificado', async () => {
    const { service, prisma } = withEvent({ workspace: { customDomain: null, customDomainVerifiedAt: null } });
    await expect(service.updateConfig('e', { useCustomDomain: true }, 'u', ADMIN)).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.event.update).not.toHaveBeenCalled();
  });

  it('guarda la elección cuando el dominio está verificado', async () => {
    const { service, prisma } = withEvent({});
    await service.updateConfig('e', { useCustomDomain: true }, 'u', ADMIN);
    expect(prisma.event.update.mock.calls[0][0].data).toEqual({ registrationUseCustomDomain: true });
  });
});
