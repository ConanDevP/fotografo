import { DelayedError } from 'bullmq';

import { SendBibEmailProcessor } from './send-bib-email.processor';
import { ChannelSendError } from '../../../api/src/messaging/delivery-errors';

const fail = (scope: any, code: string, extra: Record<string, unknown> = {}) =>
  new ChannelSendError({ scope, code, message: `mensaje ${code}`, ...extra });

const subscription = (overrides: Record<string, unknown> = {}) => ({
  id: '6f1c1d0e-2b7a-4c53-9a53-0d1f8c9e7a11',
  bib: '123', status: 'ACTIVE', locale: 'es', name: 'Ana',
  email: 'ana@correo.co', emailConsentAt: new Date(),
  phone: '+525512345678', whatsappConsentAt: new Date(),
  event: {
    id: 'evt', name: 'Maratón', slug: 'maraton', isPublished: true, deletedAt: null, workspaceId: 'ws-1',
    workspace: { name: 'Club Cronos', slug: 'ws', customDomain: null, customDomainVerifiedAt: null },
  },
  ...overrides,
});

type Routes = { email?: any; whatsapp?: any; recordFailure?: any };

function build(sub: any, photos: string[], logged: Record<string, string[]> = {}, routes: Routes = {}) {
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
  const ownEmail = { send: jest.fn().mockResolvedValue({ id: 'e1' }) };
  const ownWhatsApp = { sendTemplate: jest.fn().mockResolvedValue({ messageId: 'w1' }) };
  const mail: any = {
    buildRunnerDigest: jest.fn().mockReturnValue({ subject: 'Asunto', html: '<p>x</p>', headers: { 'List-Unsubscribe': '<u>' } }),
    sendRunnerDigest: jest.fn().mockResolvedValue(undefined),
    sendChannelAlert: jest.fn().mockResolvedValue(undefined),
  };
  const health: any = {
    emailRoute: jest.fn().mockResolvedValue(routes.email ?? { kind: 'OWN', client: ownEmail, from: 'Club <fotos@club.com>', replyTo: 'hola@club.com' }),
    whatsappRoute: jest.fn().mockResolvedValue(routes.whatsapp ?? { kind: 'OWN', client: ownWhatsApp, phoneId: '123456', template: { name: 'lucilamon_fotos_listas_v1', language: 'es' } }),
    recordFailure: routes.recordFailure ?? jest.fn().mockResolvedValue({ alert: true }),
    alertRecipient: jest.fn().mockResolvedValue({ email: 'duena@club.com', workspaceName: 'Club Cronos' }),
  };
  const config: any = {
    get: jest.fn((key: string, fallback?: unknown) => ({ FRONTEND_URL: 'https://lucilamon.com', API_URL: 'https://api.lucilamon.com', REGISTRATION_SECRET: 'x' }[key] ?? fallback)),
  };
  const processor = new SendBibEmailProcessor(prisma, mail, health, config);
  const job: any = {
    data: { subscriptionId: sub?.id, kind: 'BIB_NOTIFICATION', eventId: 'evt', bib: '', email: '' },
    updateData: jest.fn().mockResolvedValue(undefined),
    moveToDelayed: jest.fn().mockResolvedValue(undefined),
  };
  const run = () => processor.process(job, 'token-1');
  return { run, prisma, mail, health, ownEmail, ownWhatsApp, job };
}

describe('aviso agrupado por los canales del espacio', () => {
  it('con canales propios manda un correo y un WhatsApp, y la plataforma no interviene', async () => {
    const { run, mail, ownEmail, ownWhatsApp, prisma } = build(subscription(), ['p1', 'p2', 'p3']);
    await run();

    expect(ownEmail.send).toHaveBeenCalledTimes(1);
    expect(ownEmail.send.mock.calls[0][0]).toMatchObject({ from: 'Club <fotos@club.com>', to: 'ana@correo.co', replyTo: 'hola@club.com', subject: 'Asunto' });
    expect(mail.sendRunnerDigest).not.toHaveBeenCalled();
    expect(mail.buildRunnerDigest.mock.calls[0][0]).toMatchObject({
      totalPhotos: 3, locale: 'es', eventUrl: 'https://lucilamon.com/s/ws/eventos/maraton?bib=123',
    });
    expect(ownWhatsApp.sendTemplate).toHaveBeenCalledTimes(1);
    expect(ownWhatsApp.sendTemplate.mock.calls[0][0]).toEqual({
      phoneId: '123456', to: '+525512345678', name: 'lucilamon_fotos_listas_v1', language: 'es',
      params: ['Ana', 'Maratón', '3', 'https://lucilamon.com/s/ws/eventos/maraton?bib=123'],
    });
    expect(prisma.bibNotificationLog.createMany).toHaveBeenCalledTimes(2);
    expect(prisma.bibSubscription.update).toHaveBeenCalled();
  });

  it('sin correo propio sale por LucilaMon con el nombre del espacio como remitente', async () => {
    const { run, mail, ownEmail } = build(subscription({ phone: null, whatsappConsentAt: null }), ['p1'], {}, { email: { kind: 'PLATFORM' } });
    await run();
    expect(ownEmail.send).not.toHaveBeenCalled();
    expect(mail.sendRunnerDigest.mock.calls[0][0]).toMatchObject({ to: 'ana@correo.co', fromDisplayName: 'Club Cronos', totalPhotos: 1 });
  });

  it('limpia lo que va a la plantilla: nombre vacío y saltos de línea del evento', async () => {
    const sub = subscription({ name: '  ', email: null, emailConsentAt: null });
    sub.event.name = 'Gran\nFondo   Sur';
    const { run, ownWhatsApp } = build(sub, ['p1']);
    await run();
    expect(ownWhatsApp.sendTemplate.mock.calls[0][0].params.slice(0, 3)).toEqual(['corredor', 'Gran Fondo Sur', '1']);
  });

  it('un canal pausado no envía ni da el aviso por hecho: queda esperando', async () => {
    const { run, mail, ownEmail, ownWhatsApp, prisma } = build(
      subscription(), ['p1'], {},
      { email: { kind: 'PAUSED', message: 'x' }, whatsapp: { kind: 'PAUSED', message: 'y' } },
    );
    await expect(run()).resolves.toBeUndefined();
    expect(ownEmail.send).not.toHaveBeenCalled();
    expect(ownWhatsApp.sendTemplate).not.toHaveBeenCalled();
    expect(mail.sendRunnerDigest).not.toHaveBeenCalled();
    expect(prisma.bibNotificationLog.createMany).not.toHaveBeenCalled();
  });

  it('sin canal de WhatsApp propio no se manda WhatsApp, pero el correo sale', async () => {
    const { run, ownEmail, ownWhatsApp } = build(subscription(), ['p1'], {}, { whatsapp: { kind: 'NONE' } });
    await run();
    expect(ownEmail.send).toHaveBeenCalled();
    expect(ownWhatsApp.sendTemplate).not.toHaveBeenCalled();
  });

  it('si la cuenta del cliente rechaza (sin pago), pausa y avisa a su dueño una vez, sin perder el aviso', async () => {
    const { run, ownWhatsApp, mail, prisma, health, ownEmail } = build(subscription(), ['p1']);
    ownWhatsApp.sendTemplate.mockRejectedValue(fail('ACCOUNT', 'WA_BILLING', { action: 'Añade un método de pago.', helpUrl: 'https://meta/pagos' }));

    await expect(run()).resolves.toBeUndefined(); // no se reintenta en bucle
    expect(health.recordFailure).toHaveBeenCalledWith('ws-1', 'WHATSAPP', expect.objectContaining({ code: 'WA_BILLING' }), { eventId: 'evt', subscriptionId: subscription().id });
    expect(mail.sendChannelAlert).toHaveBeenCalledTimes(1);
    expect(mail.sendChannelAlert.mock.calls[0][0]).toMatchObject({
      to: 'duena@club.com', channel: 'WHATSAPP', workspaceName: 'Club Cronos', action: 'Añade un método de pago.', helpUrl: 'https://meta/pagos',
    });
    // El correo del mismo corredor sí salió y solo él se da por avisado.
    expect(ownEmail.send).toHaveBeenCalled();
    const marked = prisma.bibNotificationLog.createMany.mock.calls.map((call: any) => call[0].data[0].channel);
    expect(marked).toEqual(['EMAIL']);
  });

  it('no repite la alerta cuando ya se avisó por ese motivo', async () => {
    const recordFailure = jest.fn().mockResolvedValue({ alert: false });
    const { run, ownEmail, mail } = build(subscription({ phone: null, whatsappConsentAt: null }), ['p1'], {}, { recordFailure });
    ownEmail.send.mockRejectedValue(fail('ACCOUNT', 'EMAIL_DOMAIN_NOT_VERIFIED'));
    await run();
    expect(mail.sendChannelAlert).not.toHaveBeenCalled();
  });

  it('un destinatario imposible (teléfono sin WhatsApp) se descarta y no se reintenta', async () => {
    const { run, ownWhatsApp, prisma } = build(subscription({ email: null, emailConsentAt: null }), ['p1']);
    ownWhatsApp.sendTemplate.mockRejectedValue(fail('RECIPIENT', 'WA_UNDELIVERABLE'));
    await expect(run()).resolves.toBeUndefined();
    expect(prisma.bibNotificationLog.createMany).toHaveBeenCalledTimes(1);
  });

  it('un límite del proveedor aplaza el aviso sin gastar reintentos', async () => {
    const { run, ownEmail, job } = build(subscription({ phone: null, whatsappConsentAt: null }), ['p1']);
    ownEmail.send.mockRejectedValue(fail('LIMIT', 'EMAIL_DAILY_QUOTA', { retryAfterMs: 3_600_000 }));
    const before = Date.now();
    await expect(run()).rejects.toBeInstanceOf(DelayedError);
    expect(job.moveToDelayed).toHaveBeenCalledWith(expect.any(Number), 'token-1');
    expect(job.moveToDelayed.mock.calls[0][0]).toBeGreaterThanOrEqual(before + 3_600_000);
    expect(job.updateData).toHaveBeenCalledWith(expect.objectContaining({ limitRetries: 1 }));
  });

  it('un límite no se aplaza para siempre', async () => {
    const { run, ownEmail, job } = build(subscription({ phone: null, whatsappConsentAt: null }), ['p1']);
    job.data.limitRetries = 72;
    ownEmail.send.mockRejectedValue(fail('LIMIT', 'EMAIL_DAILY_QUOTA', { retryAfterMs: 3_600_000 }));
    await expect(run()).resolves.toBeUndefined();
    expect(job.moveToDelayed).not.toHaveBeenCalled();
  });

  it('una caída pasajera hace fallar el trabajo para que BullMQ lo reintente', async () => {
    const { run, ownEmail } = build(subscription({ phone: null, whatsappConsentAt: null }), ['p1']);
    ownEmail.send.mockRejectedValue(fail('TRANSIENT', 'EMAIL_PROVIDER_DOWN'));
    await expect(run()).rejects.toBeInstanceOf(ChannelSendError);
  });

  it('solo avisa de lo que cada canal aún no avisó', async () => {
    const { run, mail, ownEmail, ownWhatsApp } = build(subscription(), ['p1', 'p2', 'p3'], { EMAIL: ['p1', 'p2'], WHATSAPP: ['p1', 'p2', 'p3'] });
    await run();
    expect(mail.buildRunnerDigest.mock.calls[0][0].totalPhotos).toBe(1);
    expect(ownEmail.send).toHaveBeenCalledTimes(1);
    expect(ownWhatsApp.sendTemplate).not.toHaveBeenCalled();
  });

  it('no escribe a quien se dio de baja, sin consentimiento de un canal ni en eventos sin publicar', async () => {
    const baja = build(subscription({ status: 'UNSUBSCRIBED' }), ['p1']);
    await baja.run();
    expect(baja.ownEmail.send).not.toHaveBeenCalled();

    const sinConsentimiento = build(subscription({ whatsappConsentAt: null }), ['p1']);
    await sinConsentimiento.run();
    expect(sinConsentimiento.ownWhatsApp.sendTemplate).not.toHaveBeenCalled();
    expect(sinConsentimiento.ownEmail.send).toHaveBeenCalled();

    const sub = subscription();
    sub.event.isPublished = false;
    const sinPublicar = build(sub, ['p1']);
    await sinPublicar.run();
    expect(sinPublicar.ownEmail.send).not.toHaveBeenCalled();
  });

  it('usa el dominio propio del espacio cuando está verificado', async () => {
    const sub = subscription({ phone: null, whatsappConsentAt: null });
    sub.event.workspace = { name: 'Club', slug: 'ws', customDomain: 'fotos.club.com', customDomainVerifiedAt: new Date() } as any;
    const { run, mail } = build(sub, ['p1']);
    await run();
    expect(mail.buildRunnerDigest.mock.calls[0][0].eventUrl).toBe('https://fotos.club.com/eventos/maraton?bib=123');
  });
});
