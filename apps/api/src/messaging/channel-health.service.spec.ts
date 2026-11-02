import { ChannelHealthService } from './channel-health.service';
import { SecretBox } from './secret-box';

const box = new SecretBox('clave-de-prueba', false);
const config: any = { get: (key: string) => ({ PARTNER_WEBHOOK_ENCRYPTION_KEY: 'clave-de-prueba' }[key]) };

function build(rows: any[]) {
  const issues: any[] = [];
  const prisma: any = {
    workspaceChannel: {
      findUnique: jest.fn(async ({ where }: any) => {
        const k = where.workspaceId_channel;
        const found = rows.find(row => row.workspaceId === k.workspaceId && row.channel === k.channel);
        return found ? { ...found } : null;
      }),
      update: jest.fn(async ({ where, data }: any) => Object.assign(rows.find(row => row.id === where.id), data)),
    },
    deliveryIssue: {
      findFirst: jest.fn(async ({ where }: any) => issues.find(issue => issue.code === where.code && issue.channel === where.channel) ?? null),
      create: jest.fn(async ({ data }: any) => { issues.push(data); return data; }),
    },
    workspace: { findUnique: jest.fn() },
  };
  return { health: new ChannelHealthService(prisma, config), prisma, issues };
}

const emailRow = (status: string, extra: Record<string, unknown> = {}, cfg: Record<string, unknown> = {}) => ({
  id: 'c1', workspaceId: 'ws', channel: 'EMAIL', status, secretEnc: box.encrypt('re_clave_secreta_123'),
  config: { fromEmail: 'fotos@club.com', fromName: 'Club', replyTo: 'hola@club.com', fallbackToPlatform: false, ...cfg },
  lastErrorMessage: 'Tu dominio no está verificado.', lastAlertAt: null, lastAlertCode: null, ...extra,
});
const waRow = (status: string, templates: Record<string, any>) => ({
  id: 'c2', workspaceId: 'ws', channel: 'WHATSAPP', status, secretEnc: box.encrypt('EAAG-token'),
  config: { phoneId: '111', wabaId: '222', templates, warnings: [] }, lastErrorMessage: 'Sin pago.', lastAlertAt: null, lastAlertCode: null,
});

describe('qué canal usa cada aviso', () => {
  it('sin espacio, sin canal o aún pendiente, el correo sale por la plataforma', async () => {
    expect((await build([]).health.emailRoute(null)).kind).toBe('PLATFORM');
    expect((await build([]).health.emailRoute('ws')).kind).toBe('PLATFORM');
    expect((await build([emailRow('PENDING')]).health.emailRoute('ws')).kind).toBe('PLATFORM');
    expect((await build([emailRow('DISABLED')]).health.emailRoute('ws')).kind).toBe('PLATFORM');
  });

  it('con el canal activo usa el de su cuenta, con remitente con nombre y respuesta', async () => {
    const route: any = await build([emailRow('ACTIVE')]).health.emailRoute('ws');
    expect(route.kind).toBe('OWN');
    expect(route.from).toBe('Club <fotos@club.com>');
    expect(route.replyTo).toBe('hola@club.com');
  });

  it('con el canal en error, pausa (no envía desde la plataforma sin permiso) salvo que el cliente lo haya pedido', async () => {
    const paused: any = await build([emailRow('ERROR')]).health.emailRoute('ws');
    expect(paused).toEqual({ kind: 'PAUSED', message: 'Tu dominio no está verificado.' });
    const fallback = await build([emailRow('ERROR', {}, { fallbackToPlatform: true })]).health.emailRoute('ws');
    expect(fallback.kind).toBe('PLATFORM');
  });

  it('WhatsApp: solo con canal propio activo, y con la plantilla del idioma o la que haya aprobada', async () => {
    const approved = { es: { name: 'lucilamon_fotos_listas_v1', language: 'es', status: 'APPROVED' }, en: { name: 'lucilamon_fotos_listas_v1', language: 'en', status: 'APPROVED' } };
    expect((await build([]).health.whatsappRoute('ws', 'es')).kind).toBe('NONE');
    expect((await build([]).health.whatsappRoute(null, 'es')).kind).toBe('NONE');
    expect((await build([waRow('PENDING', approved)]).health.whatsappRoute('ws', 'es')).kind).toBe('NONE');

    const own: any = await build([waRow('ACTIVE', approved)]).health.whatsappRoute('ws', 'en');
    expect(own).toMatchObject({ kind: 'OWN', phoneId: '111', template: { language: 'en' } });

    const onlySpanish: any = await build([waRow('ACTIVE', { es: approved.es })]).health.whatsappRoute('ws', 'en');
    expect(onlySpanish.template.language).toBe('es');

    expect((await build([waRow('ERROR', approved)]).health.whatsappRoute('ws', 'es')).kind).toBe('PAUSED');
  });
});

describe('registro de fallos', () => {
  const account = { scope: 'ACCOUNT' as const, code: 'WA_BILLING', message: 'Sin método de pago.', action: 'Añade uno.' };

  it('un fallo de la cuenta pausa el canal con el motivo y qué hacer, y avisa una sola vez al día', async () => {
    const row = waRow('ACTIVE', { es: { status: 'APPROVED', name: 'x', language: 'es' } });
    const { health, issues } = build([row]);

    expect(await health.recordFailure('ws', 'WHATSAPP', account, { eventId: 'e1' })).toEqual({ alert: true });
    expect(row.status).toBe('ERROR');
    expect((row as any).lastErrorCode).toBe('WA_BILLING');
    expect((row as any).lastErrorMessage).toBe('Sin método de pago. Añade uno.');
    expect(issues[0]).toMatchObject({ scope: 'ACCOUNT', code: 'WA_BILLING', eventId: 'e1' });

    expect(await health.recordFailure('ws', 'WHATSAPP', account)).toEqual({ alert: false });
    // Otro motivo sí merece otro aviso.
    expect(await health.recordFailure('ws', 'WHATSAPP', { ...account, code: 'WA_TOKEN_INVALID' })).toEqual({ alert: true });
  });

  it('un fallo de un destinatario queda anotado pero no pausa el canal ni avisa', async () => {
    const row = emailRow('ACTIVE');
    const { health, issues } = build([row]);
    const result = await health.recordFailure('ws', 'EMAIL', { scope: 'RECIPIENT', code: 'EMAIL_RECIPIENT_INVALID', message: 'Correo inválido.' });
    expect(result).toEqual({ alert: false });
    expect(row.status).toBe('ACTIVE');
    expect(issues).toHaveLength(1);
  });

  it('los límites no llenan la tabla: se anota uno por hora y motivo', async () => {
    const { health, issues } = build([emailRow('ACTIVE')]);
    const limit = { scope: 'LIMIT' as const, code: 'EMAIL_DAILY_QUOTA', message: 'Cuota diaria.' };
    await health.recordFailure('ws', 'EMAIL', limit);
    await health.recordFailure('ws', 'EMAIL', limit);
    await health.recordFailure('ws', 'EMAIL', limit);
    expect(issues).toHaveLength(1);
  });
});
