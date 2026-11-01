import { SendBibEmailProcessor } from './send-bib-email.processor';
import { WhatsAppDeliveryError } from '../services/whatsapp.service';

const subscription = (overrides: Record<string, unknown> = {}) => ({
  id: '6f1c1d0e-2b7a-4c53-9a53-0d1f8c9e7a11',
  bib: '123', status: 'ACTIVE', locale: 'es', name: 'Ana',
  email: 'ana@correo.co', emailConsentAt: new Date(),
  phone: '+525512345678', whatsappConsentAt: new Date(),
  event: {
    id: 'evt', name: 'Maratón', slug: 'maraton', isPublished: true, deletedAt: null,
    workspace: { slug: 'ws', customDomain: null, customDomainVerifiedAt: null },
  },
  ...overrides,
});

function build(sub: any, photos: string[], logged: Record<string, string[]> = {}, whatsappEnabled = true) {
  const prisma: any = {
    bibSubscription: { findUnique: jest.fn().mockResolvedValue(sub), update: jest.fn() },
    photoBib: {
      findMany: jest.fn().mockResolvedValue(photos.map(id => ({ photoId: id, photo: { watermarkThumbUrl: `https://cdn/${id}-wm.jpg`, watermarkUrl: `https://cdn/${id}.jpg` } }))),
    },
    bibNotificationLog: {
      findMany: jest.fn().mockImplementation(({ where }) => Promise.resolve((logged[where.channel] || []).map(photoId => ({ photoId })))),
      createMany: jest.fn(),
    },
  };
  const mail: any = { sendRunnerDigest: jest.fn().mockResolvedValue(undefined) };
  const whatsApp: any = { enabled: () => whatsappEnabled, sendPhotosReady: jest.fn().mockResolvedValue(undefined) };
  const config: any = {
    get: jest.fn((key: string, fallback?: unknown) => ({ FRONTEND_URL: 'https://lucilamon.com', API_URL: 'https://api.lucilamon.com', REGISTRATION_SECRET: 'x' }[key] ?? fallback)),
  };
  const processor = new SendBibEmailProcessor(prisma, mail, whatsApp, config);
  const run = () => processor.process({ data: { subscriptionId: sub?.id, kind: 'BIB_NOTIFICATION', eventId: 'evt', bib: '123', email: '' } } as any);
  return { run, prisma, mail, whatsApp };
}

describe('aviso agrupado', () => {
  it('manda un solo correo y un solo WhatsApp con todas las fotos nuevas', async () => {
    const { run, mail, whatsApp, prisma } = build(subscription(), ['p1', 'p2', 'p3']);
    await run();

    expect(mail.sendRunnerDigest).toHaveBeenCalledTimes(1);
    expect(mail.sendRunnerDigest.mock.calls[0][0]).toMatchObject({
      to: 'ana@correo.co', totalPhotos: 3, locale: 'es',
      eventUrl: 'https://lucilamon.com/s/ws/eventos/maraton?bib=123',
    });
    expect(mail.sendRunnerDigest.mock.calls[0][0].previews).toEqual(['https://cdn/p1-wm.jpg', 'https://cdn/p2-wm.jpg', 'https://cdn/p3-wm.jpg']);
    expect(mail.sendRunnerDigest.mock.calls[0][0].unsubscribePostUrl).toMatch(/^https:\/\/api\.lucilamon\.com\/v1\/public\/registrations\/unsubscribe\?t=/);
    expect(whatsApp.sendPhotosReady).toHaveBeenCalledTimes(1);
    expect(whatsApp.sendPhotosReady.mock.calls[0][0]).toMatchObject({ to: '+525512345678', photoCount: 3, name: 'Ana' });
    expect(prisma.bibNotificationLog.createMany).toHaveBeenCalledTimes(2);
    expect(prisma.bibSubscription.update).toHaveBeenCalled();
  });

  it('solo avisa de lo que ese canal aún no avisó', async () => {
    const { run, mail, whatsApp } = build(subscription(), ['p1', 'p2', 'p3'], { EMAIL: ['p1', 'p2'], WHATSAPP: ['p1', 'p2', 'p3'] });
    await run();
    expect(mail.sendRunnerDigest.mock.calls[0][0].totalPhotos).toBe(1);
    expect(whatsApp.sendPhotosReady).not.toHaveBeenCalled();
  });

  it('si ya avisó todo, no manda nada', async () => {
    const { run, mail, prisma } = build(subscription(), ['p1'], { EMAIL: ['p1'], WHATSAPP: ['p1'] });
    await run();
    expect(mail.sendRunnerDigest).not.toHaveBeenCalled();
    expect(prisma.bibSubscription.update).not.toHaveBeenCalled();
  });

  it('no escribe a quien se dio de baja ni en eventos sin publicar', async () => {
    const baja = build(subscription({ status: 'UNSUBSCRIBED' }), ['p1']);
    await baja.run();
    expect(baja.mail.sendRunnerDigest).not.toHaveBeenCalled();

    const sinPublicar = build(subscription({ event: { ...subscription().event, isPublished: false } }), ['p1']);
    await sinPublicar.run();
    expect(sinPublicar.mail.sendRunnerDigest).not.toHaveBeenCalled();
  });

  it('respeta el consentimiento de cada canal', async () => {
    const { run, mail, whatsApp } = build(subscription({ whatsappConsentAt: null }), ['p1']);
    await run();
    expect(mail.sendRunnerDigest).toHaveBeenCalled();
    expect(whatsApp.sendPhotosReady).not.toHaveBeenCalled();
  });

  it('con WhatsApp apagado solo sale el correo', async () => {
    const { run, mail, whatsApp } = build(subscription(), ['p1'], {}, false);
    await run();
    expect(mail.sendRunnerDigest).toHaveBeenCalled();
    expect(whatsApp.sendPhotosReady).not.toHaveBeenCalled();
  });

  it('un fallo pasajero de WhatsApp se reintenta sin repetir el correo', async () => {
    const { run, mail, whatsApp, prisma } = build(subscription(), ['p1']);
    whatsApp.sendPhotosReady.mockRejectedValue(new WhatsAppDeliveryError('429', false));
    await expect(run()).rejects.toThrow('429');

    // El correo quedó registrado como avisado: el reintento ya no lo repite.
    const channels = prisma.bibNotificationLog.createMany.mock.calls.map((call: any) => call[0].data[0].channel);
    expect(channels).toEqual(['EMAIL']);
    expect(mail.sendRunnerDigest).toHaveBeenCalledTimes(1);
  });

  it('un fallo permanente de WhatsApp no se reintenta eternamente', async () => {
    const { run, whatsApp, prisma } = build(subscription({ email: null, emailConsentAt: null }), ['p1']);
    whatsApp.sendPhotosReady.mockRejectedValue(new WhatsAppDeliveryError('131026', true));
    await expect(run()).resolves.toBeUndefined();
    expect(prisma.bibNotificationLog.createMany).toHaveBeenCalledTimes(1);
  });

  it('usa el dominio propio del espacio cuando está verificado', async () => {
    const sub = subscription({
      event: { ...subscription().event, workspace: { slug: 'ws', customDomain: 'fotos.club.com', customDomainVerifiedAt: new Date() } },
    });
    const { run, mail } = build(sub, ['p1']);
    await run();
    expect(mail.sendRunnerDigest.mock.calls[0][0].eventUrl).toBe('https://fotos.club.com/eventos/maraton?bib=123');
  });
});
