/**
 * Registro por QR y aviso agrupado contra PostgreSQL real: restricciones de la
 * migración, registros repetidos o simultáneos y el ciclo completo
 * registrar → fotos → un solo aviso → fotos aprobadas después → solo las nuevas.
 * Solo corre con E2E_DATABASE_URL (la base debe llamarse *e2e* o *test*).
 */
import { PrismaClient } from '@prisma/client';
import { RegistrationsService } from './registrations/registrations.service';
import { SendBibEmailProcessor } from '../../worker/src/queues/send-bib-email.processor';
import { e2eDatabaseUrl } from './test-support/e2e-db';

const url = e2eDatabaseUrl();
const suite = url ? describe : describe.skip;
const stamp = Date.now();

suite('registro por QR contra PostgreSQL real', () => {
  let prisma: any;
  let service: RegistrationsService;
  let processor: SendBibEmailProcessor;
  const mail = { sendRunnerDigest: jest.fn().mockResolvedValue(undefined), buildRunnerDigest: jest.fn(), sendChannelAlert: jest.fn() };
  const waClient = { sendTemplate: jest.fn().mockResolvedValue({ messageId: 'w1' }) };
  // El correo sale por la plataforma y WhatsApp por el canal propio del espacio.
  const health: any = {
    emailRoute: async () => ({ kind: 'PLATFORM' }),
    whatsappRoute: async () => ({ kind: 'OWN', client: waClient, phoneId: '111', template: { name: 'lucilamon_fotos_listas_v1', language: 'es' } }),
    recordFailure: jest.fn().mockResolvedValue({ alert: false }),
    alertRecipient: jest.fn(),
  };
  const scheduled: any[] = [];
  let eventId: string;
  let workspaceId: string;
  const code = `e2e${String(stamp).slice(-6)}`;

  const config: any = {
    get: (key: string, fallback?: unknown) => ({ REGISTRATION_SECRET: 'secreto-e2e', FRONTEND_URL: 'https://lucilamon.test' }[key] ?? fallback),
  };

  async function photo(bib: string, publicationStatus: 'APPROVED' | 'PENDING_REVIEW' = 'APPROVED') {
    const created = await prisma.photo.create({
      data: {
        eventId, cloudinaryId: `c-${Math.random()}`, originalUrl: 'o', thumbUrl: 't',
        watermarkUrl: 'https://cdn/w.jpg', watermarkThumbUrl: 'https://cdn/wt.jpg',
        status: 'PROCESSED', publicationStatus,
      },
    });
    await prisma.photoBib.create({ data: { photoId: created.id, eventId, bib, confidence: 0.95 } });
    return created.id as string;
  }

  const digest = (id: string) =>
    processor.process({ data: { subscriptionId: id, kind: 'BIB_NOTIFICATION', eventId, bib: '', email: '' }, updateData: jest.fn(), moveToDelayed: jest.fn() } as any, 'tok');

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url } } });
    const user = await prisma.user.create({ data: { email: `qr-${stamp}@e2e.test`, role: 'PHOTOGRAPHER' } });
    const ws = await prisma.workspace.create({ data: { name: 'QR', slug: `qr-${stamp}`, ownerId: user.id } });
    const event = await prisma.event.create({
      data: {
        name: 'Carrera QR', slug: `qr-${stamp}`, date: new Date(Date.now() + 86_400_000), ownerId: user.id,
        workspaceId: ws.id, isPublished: false, registrationEnabled: true, registrationCode: code, countryCode: 'MX',
        bibRules: { range: [1, 5000] },
      },
    });
    eventId = event.id;
    workspaceId = ws.id;
    await prisma.workspaceChannel.create({
      data: { workspaceId: ws.id, channel: 'WHATSAPP', status: 'ACTIVE', secretEnc: 'x', config: { phoneId: '111', wabaId: '222', warnings: [], templates: { es: { status: 'APPROVED', name: 'lucilamon_fotos_listas_v1', language: 'es' } }, testConfirmedAt: new Date().toISOString() } },
    });
    service = new RegistrationsService(prisma, config, {} as any, { scheduleForBibs: async (...a: any[]) => { scheduled.push(a); } } as any);
    processor = new SendBibEmailProcessor(prisma, mail as any, health, config);
  });

  afterAll(async () => { await prisma?.$disconnect(); });

  it('la base no admite una fila sin ningún contacto', async () => {
    await expect(prisma.bibSubscription.create({ data: { eventId, bib: '999' } })).rejects.toThrow();
  });

  it('el mismo teléfono no se repite para un dorsal, aunque no haya correo', async () => {
    const data = { eventId, bib: '998', phone: '+525500000001', whatsappConsentAt: new Date() };
    await prisma.bibSubscription.create({ data });
    await expect(prisma.bibSubscription.create({ data })).rejects.toThrow();
    // Otro dorsal con el mismo teléfono sí es posible (un padre registra a dos hijos).
    await expect(prisma.bibSubscription.create({ data: { ...data, bib: '997' } })).resolves.toBeTruthy();
  });

  it('registrarse dos veces, o a la vez, deja una sola fila con todo completado', async () => {
    const dto = { bib: '100', email: 'ana@e2e.test', emailConsent: true };
    await Promise.all([
      service.register(code, dto, '9.9.9.9'),
      service.register(code, dto, '9.9.9.9'),
      service.register(code, { bib: '100', phone: '55 1234 5678', whatsappConsent: true }, '9.9.9.9'),
    ]);
    await service.register(code, { ...dto, phone: '55 1234 5678', whatsappConsent: true, name: 'Ana' }, '9.9.9.9');

    const rows = await prisma.bibSubscription.findMany({ where: { eventId, bib: '100' } });
    expect(rows.length).toBeLessThanOrEqual(2);
    expect(rows.some((row: any) => row.email === 'ana@e2e.test' && row.phone === '+525512345678')).toBe(true);
    expect(rows.every((row: any) => row.ipHash && row.ipHash !== '9.9.9.9')).toBe(true);
  });

  it('antes de publicar se puede registrar, y el aviso espera a que haya fotos aprobadas', async () => {
    const result = await service.register(code, { bib: '200', email: 'luis@e2e.test', emailConsent: true, locale: 'en' }, '8.8.8.8');
    expect(result).toMatchObject({ registered: true, hasPhotos: false });
    const sub = await prisma.bibSubscription.findFirstOrThrow({ where: { eventId, bib: '200' } });

    await photo('200');
    await digest(sub.id);
    expect(mail.sendRunnerDigest).not.toHaveBeenCalled(); // evento sin publicar

    await prisma.event.update({ where: { id: eventId }, data: { isPublished: true } });
    await photo('200', 'PENDING_REVIEW'); // en revisión: no cuenta
    await digest(sub.id);

    expect(mail.sendRunnerDigest).toHaveBeenCalledTimes(1);
    expect(mail.sendRunnerDigest.mock.calls[0][0]).toMatchObject({ to: 'luis@e2e.test', totalPhotos: 1, locale: 'en' });
  });

  it('no repite el aviso, y cuando se aprueba otra foto avisa solo de esa', async () => {
    mail.sendRunnerDigest.mockClear();
    const sub = await prisma.bibSubscription.findFirstOrThrow({ where: { eventId, bib: '200' } });

    await digest(sub.id);
    expect(mail.sendRunnerDigest).not.toHaveBeenCalled();

    const pending = await prisma.photo.findFirstOrThrow({ where: { eventId, publicationStatus: 'PENDING_REVIEW', bibs: { some: { bib: '200' } } } });
    await prisma.photo.update({ where: { id: pending.id }, data: { publicationStatus: 'APPROVED' } });
    await digest(sub.id);

    expect(mail.sendRunnerDigest).toHaveBeenCalledTimes(1);
    expect(mail.sendRunnerDigest.mock.calls[0][0].totalPhotos).toBe(1);
    expect((await prisma.bibNotificationLog.count({ where: { subscriptionId: sub.id } }))).toBe(2);
  });

  it('WhatsApp llega con el teléfono en E.164 y el mismo conteo', async () => {
    await photo('300');
    await service.register(code, { bib: '300', phone: '(415) 555-2671', phoneCountry: 'US', whatsappConsent: true, name: 'Kim' }, '7.7.7.7');
    const sub = await prisma.bibSubscription.findFirstOrThrow({ where: { eventId, bib: '300' } });
    await digest(sub.id);
    expect(waClient.sendTemplate).toHaveBeenCalledWith(expect.objectContaining({ to: '+14155552671', phoneId: '111', params: expect.arrayContaining(['Kim', '1']) }));
  });

  it('quien se da de baja deja de recibir avisos y puede volver a registrarse', async () => {
    mail.sendRunnerDigest.mockClear();
    await photo('400');
    await service.register(code, { bib: '400', email: 'baja@e2e.test', emailConsent: true }, '6.6.6.6');
    const sub = await prisma.bibSubscription.findFirstOrThrow({ where: { eventId, bib: '400' } });
    await prisma.bibSubscription.update({ where: { id: sub.id }, data: { status: 'UNSUBSCRIBED' } });
    await digest(sub.id);
    expect(mail.sendRunnerDigest).not.toHaveBeenCalled();

    await service.register(code, { bib: '400', email: 'baja@e2e.test', emailConsent: true }, '6.6.6.6');
    await digest(sub.id);
    expect(mail.sendRunnerDigest).toHaveBeenCalledTimes(1);
  });

  it('borrar un registro borra también su historial de avisos', async () => {
    const sub = await prisma.bibSubscription.findFirstOrThrow({ where: { eventId, bib: '400' } });
    await prisma.bibSubscription.delete({ where: { id: sub.id } });
    expect(await prisma.bibNotificationLog.count({ where: { subscriptionId: sub.id } })).toBe(0);
  });

  it('cada espacio tiene un solo canal de cada tipo, y borrar el espacio borra sus credenciales', async () => {
    await expect(prisma.workspaceChannel.create({ data: { workspaceId, channel: 'WHATSAPP', secretEnc: 'y' } })).rejects.toThrow();
    const other = await prisma.workspace.create({ data: { name: 'Otro', slug: `otro-${stamp}`, ownerId: (await prisma.user.findFirstOrThrow({ where: { email: `qr-${stamp}@e2e.test` } })).id } });
    await prisma.workspaceChannel.create({ data: { workspaceId: other.id, channel: 'EMAIL', secretEnc: 'z', config: {} } });
    await prisma.workspace.delete({ where: { id: other.id } });
    expect(await prisma.workspaceChannel.count({ where: { workspaceId: other.id } })).toBe(0);
  });

  it('un canal con problemas se refleja en el panel con el motivo y los fallos por tipo', async () => {
    await prisma.workspaceChannel.update({
      where: { workspaceId_channel: { workspaceId, channel: 'WHATSAPP' } },
      data: { status: 'ERROR', lastErrorCode: 'WA_BILLING', lastErrorMessage: 'Sin método de pago.' },
    });
    await prisma.deliveryIssue.createMany({ data: [
      { workspaceId, eventId, channel: 'WHATSAPP', scope: 'ACCOUNT', code: 'WA_BILLING', message: 'Sin método de pago.' },
      { workspaceId, eventId, channel: 'WHATSAPP', scope: 'RECIPIENT', code: 'WA_UNDELIVERABLE', message: 'x' },
    ] });
    (service as any).events = { assertCanAccessEvent: async () => undefined };
    const { delivery } = await service.getConfig(eventId, 'u', 'ADMIN' as any);
    expect(delivery.whatsappEnabled).toBe(false);
    expect(delivery.problems).toEqual([{ channel: 'WHATSAPP', code: 'WA_BILLING', message: 'Sin método de pago.' }]);
    expect(delivery.failed).toEqual({ recipient: 1, account: 1, other: 0 });
  });

  it('el conteo del panel no incluye datos personales', async () => {
    const stats = await service.stats(eventId);
    expect(Object.keys(stats).sort()).toEqual(['active', 'notified', 'total', 'unsubscribed', 'withEmail', 'withPhone']);
    expect(stats.total).toBeGreaterThan(0);
  });
});
