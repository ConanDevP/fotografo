import { BadRequestException, ForbiddenException } from '@nestjs/common';

import { ChannelsService } from './channels.service';
import { ChannelHealthService } from './channel-health.service';

type Row = Record<string, any>;

/** Base de datos en memoria con lo justo que usa el servicio. */
function fakePrisma() {
  const rows: Row[] = [];
  let id = 0;
  const key = (where: any) => (where.workspaceId_channel ? where.workspaceId_channel : null);
  const match = (row: Row, where: any) => {
    const k = key(where);
    if (k) return row.workspaceId === k.workspaceId && row.channel === k.channel;
    if (where.id) return row.id === where.id;
    return Object.entries(where).every(([field, value]) => (value as any)?.in ? (value as any).in.includes(row[field]) : row[field] === value);
  };
  const workspaceChannel = {
    // Como Prisma, devuelve copias: lo leído no cambia solo al actualizar la fila.
    findUnique: jest.fn(async ({ where }: any) => { const found = rows.find(row => match(row, where)); return found ? { ...found } : null; }),
    findMany: jest.fn(async ({ where }: any = {}) => rows.filter(row => !where || match(row, where)).map(row => ({ ...row }))),
    upsert: jest.fn(async ({ where, update, create }: any) => {
      const found = rows.find(row => match(row, where));
      if (found) return { ...Object.assign(found, update, { updatedAt: new Date() }) };
      const row = { id: `ch-${++id}`, ...create, updatedAt: new Date() };
      rows.push(row);
      return { ...row };
    }),
    update: jest.fn(async ({ where, data }: any) => ({ ...Object.assign(rows.find(row => match(row, where))!, data, { updatedAt: new Date() }) })),
    deleteMany: jest.fn(async ({ where }: any) => { const before = rows.length; for (let i = rows.length - 1; i >= 0; i -= 1) if (match(rows[i], where)) rows.splice(i, 1); return { count: before - rows.length }; }),
  };
  const prisma: any = {
    workspaceChannel,
    deliveryIssue: { groupBy: jest.fn().mockResolvedValue([]), findMany: jest.fn().mockResolvedValue([]) },
    workspace: { findUnique: jest.fn().mockResolvedValue({ name: 'Club Cronos', contactEmail: 'duena@club.com', owner: { email: 'o@club.com' } }) },
  };
  return { prisma, rows };
}

type Reply = { status?: number; body: any };
function mockFetch(routes: Array<[RegExp, Reply | ((init: any) => Reply)]>) {
  const calls: Array<{ method: string; url: string; body: any }> = [];
  const original = global.fetch;
  global.fetch = jest.fn(async (url: any, init: any = {}) => {
    const method = init.method || 'GET';
    calls.push({ method, url: String(url), body: init.body ? JSON.parse(init.body) : undefined });
    const route = routes.find(([pattern]) => pattern.test(`${method} ${url}`));
    const reply = route ? (typeof route[1] === 'function' ? route[1](init) : route[1]) : { status: 404, body: { error: { code: 100, message: 'sin ruta' } } };
    const status = reply.status ?? 200;
    return { ok: status < 400, status, json: async () => reply.body } as any;
  }) as any;
  return { calls, restore: () => { global.fetch = original; } };
}

const META = { error: (code: number, extra: Record<string, unknown> = {}) => ({ status: 400, body: { error: { code, message: 'm', ...extra } } }) };
const WS = 'ws-1';
const USER = 'u-1';
const RESEND_KEY = 're_1234567890abcdefghij';
const TOKEN = 'EAAG' + 'x'.repeat(60);

function build(options: { forbidden?: boolean; resendKey?: string } = {}) {
  const { prisma, rows } = fakePrisma();
  const config: any = {
    get: (key: string, fallback?: unknown) => ({ PARTNER_WEBHOOK_ENCRYPTION_KEY: 'clave-de-prueba', FRONTEND_URL: 'https://lucilamon.com', RESEND_API_KEY: options.resendKey }[key] ?? fallback),
  };
  const workspaces: any = { assertAccess: options.forbidden ? jest.fn().mockRejectedValue(new ForbiddenException('No')) : jest.fn().mockResolvedValue({ role: 'OWNER' }) };
  const scheduler: any = { scheduleForWorkspace: jest.fn().mockResolvedValue(2) };
  const mailer: any = { send: jest.fn().mockResolvedValue(true) };
  const health = new ChannelHealthService(prisma, config);
  const service = new ChannelsService(prisma, config, workspaces, scheduler, mailer, health);
  return { service, prisma, rows, workspaces, scheduler, mailer };
}

const rejects = async (promise: Promise<unknown>) => {
  try { await promise; } catch (error) { return error as BadRequestException; }
  throw new Error('debía fallar');
};
const detail = (error: BadRequestException): any => (error.getResponse() as any);

describe('correo con el Resend del cliente', () => {
  const emailDto = { apiKey: RESEND_KEY, fromEmail: 'fotos@club.com', fromName: 'Club Cronos' };
  const domains = (status: string) => [/^GET .*\/domains$/, { body: { data: [{ id: 'd1', name: 'club.com', status }, { id: 'd2', name: 'otro.com', status: 'verified' }] } }] as [RegExp, Reply];

  it('con el dominio verificado queda activo, cifra la clave y no la devuelve', async () => {
    const { service, rows, scheduler } = build();
    const http = mockFetch([domains('verified')]);
    const view: any = await service.connectEmail(WS, emailDto as any, USER);
    http.restore();

    expect(view.status).toBe('ACTIVE');
    expect(view.config).toMatchObject({ fromEmail: 'fotos@club.com', domain: 'club.com', domainStatus: 'verified', fallbackToPlatform: false });
    expect(JSON.stringify(view)).not.toContain(RESEND_KEY);
    expect(view.secretHint).toBe('…ghij');
    expect(rows[0].secretEnc).not.toContain(RESEND_KEY);
    expect(rows[0].secretEnc.split('.')).toHaveLength(3);
    expect(scheduler.scheduleForWorkspace).toHaveBeenCalledWith(WS);
  });

  it('con el dominio pendiente de DNS queda pendiente, sin activar', async () => {
    const { service, scheduler } = build();
    const http = mockFetch([domains('pending')]);
    const view: any = await service.connectEmail(WS, emailDto as any, USER);
    http.restore();
    expect(view.status).toBe('PENDING');
    expect(view.config.domainStatus).toBe('pending');
    expect(scheduler.scheduleForWorkspace).not.toHaveBeenCalled();
  });

  it('si el dominio no está en su cuenta de Resend, lo dice y enumera los que tiene', async () => {
    const { service, rows } = build();
    const http = mockFetch([[/^GET .*\/domains$/, { body: { data: [{ id: 'd2', name: 'otro.com', status: 'verified' }] } }]]);
    const error = await rejects(service.connectEmail(WS, emailDto as any, USER));
    http.restore();
    expect(detail(error)).toMatchObject({ code: 'EMAIL_DOMAIN_NOT_FOUND' });
    expect(detail(error).message).toContain('club.com');
    expect(detail(error).message).toContain('otro.com');
    expect(rows).toHaveLength(0);
  });

  it('rechaza el remitente de pruebas de Resend', async () => {
    const { service } = build();
    const error = await rejects(service.connectEmail(WS, { ...emailDto, fromEmail: 'onboarding@resend.dev' } as any, USER));
    expect(detail(error).code).toBe('EMAIL_FROM_TEST_DOMAIN');
  });

  it('una clave inválida da un mensaje claro con qué hacer', async () => {
    const { service, rows } = build();
    const http = mockFetch([[/^GET .*\/domains$/, { status: 401, body: { statusCode: 401, name: 'invalid_api_key', message: 'API key is invalid' } }]]);
    const error = await rejects(service.connectEmail(WS, emailDto as any, USER));
    http.restore();
    expect(detail(error)).toMatchObject({ code: 'EMAIL_KEY_INVALID' });
    expect(detail(error).action).toMatch(/Resend/);
    expect(rows).toHaveLength(0);
  });

  it('una clave de solo envío no puede listar dominios: queda pendiente hasta que un correo de prueba llegue', async () => {
    const { service, scheduler } = build();
    const restricted = [/^GET .*\/domains$/, { status: 401, body: { statusCode: 401, name: 'restricted_api_key', message: 'restricted' } }] as [RegExp, Reply];
    const http = mockFetch([restricted, [/^POST .*\/emails$/, { body: { id: 'em_1' } }]]);
    const connected: any = await service.connectEmail(WS, emailDto as any, USER);
    expect(connected.status).toBe('PENDING');
    expect(connected.config.domainStatus).toBe('unknown');

    const tested: any = await service.testEmail(WS, 'yo@club.com', USER);
    http.restore();
    expect(tested.status).toBe('ACTIVE');
    expect(scheduler.scheduleForWorkspace).toHaveBeenCalled();
    const sent = http.calls.find(call => call.url.endsWith('/emails'))!.body;
    expect(sent).toMatchObject({ from: 'Club Cronos <fotos@club.com>', to: ['yo@club.com'] });
  });

  it('el correo de prueba con un dominio sin verificar guarda el motivo en el canal y lo explica', async () => {
    const { service, rows } = build();
    const http = mockFetch([
      domains('verified'),
      [/^POST .*\/emails$/, { status: 403, body: { statusCode: 403, name: 'validation_error', message: 'The club.com domain is not verified.' } }],
    ]);
    await service.connectEmail(WS, emailDto as any, USER);
    const error = await rejects(service.testEmail(WS, 'yo@club.com', USER));
    http.restore();
    expect(detail(error).code).toBe('EMAIL_DOMAIN_NOT_VERIFIED');
    expect(rows[0].status).toBe('ERROR');
    expect(rows[0].lastErrorCode).toBe('EMAIL_DOMAIN_NOT_VERIFIED');
    expect(rows[0].lastErrorMessage).toMatch(/Resend/);
  });

  it('revalidar un dominio que ya quedó verificado activa el canal y reanuda los avisos', async () => {
    const { service, scheduler } = build();
    let status = 'pending';
    const http = mockFetch([
      [/^GET .*\/domains$/, () => ({ body: { data: [{ id: 'd1', name: 'club.com', status }] } })],
      [/^POST .*\/domains\/d1\/verify$/, { body: { object: 'domain', id: 'd1' } }],
      [/^GET .*\/domains\/d1$/, () => ({ body: { id: 'd1', name: 'club.com', status } })],
    ]);
    await service.connectEmail(WS, emailDto as any, USER);
    status = 'verified';
    const view: any = await service.verifyEmail(WS, USER);
    http.restore();
    expect(view.status).toBe('ACTIVE');
    expect(view.config.domainStatus).toBe('verified');
    expect(scheduler.scheduleForWorkspace).toHaveBeenCalled();
  });

  it('solo dueños y administradores del espacio pueden conectar canales', async () => {
    const { service, workspaces } = build({ forbidden: true });
    await expect(service.connectEmail(WS, emailDto as any, USER)).rejects.toBeInstanceOf(ForbiddenException);
    expect(workspaces.assertAccess.mock.calls[0][2]).toEqual(['OWNER', 'ADMIN']);
  });
});

describe('WhatsApp Business del cliente', () => {
  const dto = { accessToken: TOKEN, phoneId: '111222333', wabaId: '999888777' };
  const phone = (extra: Record<string, unknown> = {}) => ({
    id: '111222333', display_phone_number: '+52 55 1234 5678', verified_name: 'Club Cronos', quality_rating: 'GREEN',
    messaging_limit_tier: 'TIER_1K', name_status: 'APPROVED', platform_type: 'CLOUD_API', status: 'CONNECTED', ...extra,
  });
  const account = [/^GET .*\/999888777\?fields=id,name,currency/, { body: { id: '999888777', name: 'Club Cronos WABA', currency: 'MXN' } }] as [RegExp, Reply];
  const review = [/^GET .*\/999888777\?fields=account_review_status/, { body: { account_review_status: 'APPROVED' } }] as [RegExp, Reply];
  const phones = (list: any[]) => [/^GET .*\/999888777\/phone_numbers/, { body: { data: list } }] as [RegExp, Reply];
  const noTemplates = [/^GET .*\/999888777\/message_templates/, { body: { data: [] } }] as [RegExp, Reply];

  it('un token vencido se explica sin culpar a LucilaMon', async () => {
    const { service, rows } = build();
    const http = mockFetch([[/\/999888777\?fields=id,name,currency/, META.error(190)]]);
    const error = await rejects(service.connectWhatsApp(WS, dto, USER));
    http.restore();
    expect(detail(error).code).toBe('WA_TOKEN_INVALID');
    expect(detail(error).message).toMatch(/24 horas/);
    expect(rows).toHaveLength(0);
  });

  it('un ID de número que no es de esa cuenta lista los números que sí tiene', async () => {
    const { service } = build();
    const http = mockFetch([account, review, phones([phone({ id: '555', display_phone_number: '+52 81 0000 0000' })])]);
    const error = await rejects(service.connectWhatsApp(WS, dto, USER));
    http.restore();
    expect(detail(error).code).toBe('WA_PHONE_NOT_IN_ACCOUNT');
    expect(detail(error).message).toContain('+52 81 0000 0000');
    expect(detail(error).message).toContain('ID 555');
  });

  it('conecta, avisa de lo que puede limitar el envío y queda pendiente hasta aprobar y probar', async () => {
    const { service, rows } = build();
    const http = mockFetch([
      account, review,
      phones([phone({ messaging_limit_tier: 'TIER_250', quality_rating: 'RED', platform_type: 'NOT_APPLICABLE', name_status: 'PENDING_REVIEW' })]),
      noTemplates,
    ]);
    const view: any = await service.connectWhatsApp(WS, dto, USER);
    http.restore();
    expect(view.status).toBe('PENDING');
    expect(view.config).toMatchObject({ displayPhone: '+52 55 1234 5678', verifiedName: 'Club Cronos', accountName: 'Club Cronos WABA' });
    const warnings = view.config.warnings.join(' | ');
    expect(warnings).toMatch(/250 conversaciones/);
    expect(warnings).toMatch(/calidad.*rojo/);
    expect(warnings).toMatch(/Cloud API/);
    expect(warnings).toMatch(/nombre visible/);
    expect(JSON.stringify(view)).not.toContain(TOKEN);
    expect(rows[0].secretEnc).not.toContain(TOKEN);
  });

  async function connected(templates: any[] = []) {
    const ctx = build();
    const http = mockFetch([account, review, phones([phone()]), [/^GET .*\/999888777\/message_templates/, { body: { data: templates } }]]);
    await ctx.service.connectWhatsApp(WS, dto, USER);
    http.restore();
    return ctx;
  }

  it('envía a revisión las plantillas en español e inglés como Utilidad y con 4 ejemplos', async () => {
    const { service } = await connected();
    const http = mockFetch([
      [/^GET .*\/message_templates/, { body: { data: [] } }],
      [/^POST .*\/999888777\/message_templates$/, (init: any) => ({ body: { id: `t-${JSON.parse(init.body).language}`, status: 'PENDING', category: 'UTILITY' } })],
    ]);
    const result: any = await service.submitTemplates(WS, USER);
    http.restore();

    const created = http.calls.filter(call => call.method === 'POST').map(call => call.body);
    expect(created.map(body => body.language).sort()).toEqual(['en', 'es']);
    for (const body of created) {
      expect(body).toMatchObject({ name: 'lucilamon_fotos_listas_v1', category: 'UTILITY' });
      const bodyComponent = body.components[0];
      expect(bodyComponent.type).toBe('BODY');
      expect(bodyComponent.text).toMatch(/\{\{1\}\}.*\{\{2\}\}.*\{\{3\}\}.*\{\{4\}\}/);
      expect(bodyComponent.text).not.toMatch(/\{\{4\}\}\s*$/); // Meta no admite una variable al final
      expect(bodyComponent.example.body_text[0]).toHaveLength(4);
    }
    expect(result.channel.config.templates.es).toMatchObject({ status: 'PENDING', version: 1 });
    expect(result.problems).toEqual([]);
  });

  it('no duplica plantillas que ya están en revisión o aprobadas', async () => {
    const { service } = await connected();
    const http = mockFetch([[/^GET .*\/message_templates/, { body: { data: [
      { id: 'a', name: 'lucilamon_fotos_listas_v1', language: 'es', status: 'APPROVED', category: 'UTILITY' },
      { id: 'b', name: 'lucilamon_fotos_listas_v1', language: 'en', status: 'PENDING', category: 'UTILITY' },
    ] } }]]);
    await service.submitTemplates(WS, USER);
    http.restore();
    expect(http.calls.some(call => call.method === 'POST')).toBe(false);
  });

  it('una plantilla rechazada se reenvía como versión nueva', async () => {
    const { service } = await connected();
    const http = mockFetch([
      [/^GET .*\/message_templates/, { body: { data: [
        { id: 'a', name: 'lucilamon_fotos_listas_v1', language: 'es', status: 'REJECTED', category: 'UTILITY', rejected_reason: 'INVALID_FORMAT' },
        { id: 'b', name: 'lucilamon_fotos_listas_v1', language: 'en', status: 'APPROVED', category: 'UTILITY' },
      ] } }],
      [/^POST .*\/message_templates$/, { body: { id: 'n', status: 'PENDING', category: 'UTILITY' } }],
    ]);
    await service.submitTemplates(WS, USER);
    http.restore();
    const created = http.calls.filter(call => call.method === 'POST');
    expect(created).toHaveLength(1);
    expect(created[0].body).toMatchObject({ name: 'lucilamon_fotos_listas_v2', language: 'es' });
  });

  it('si Meta no acepta ninguna, lo dice; si solo falla un idioma, devuelve el problema sin tumbar el otro', async () => {
    const { service } = await connected();
    let http = mockFetch([[/^GET .*\/message_templates/, { body: { data: [] } }], [/^POST .*\/message_templates$/, META.error(10)]]);
    const error = await rejects(service.submitTemplates(WS, USER));
    http.restore();
    expect(detail(error).code).toBe('WA_TEMPLATE_SUBMIT_FAILED');

    http = mockFetch([
      [/^GET .*\/message_templates/, { body: { data: [] } }],
      [/^POST .*\/message_templates$/, (init: any) => (JSON.parse(init.body).language === 'es' ? { body: { id: 'x', status: 'PENDING', category: 'UTILITY' } } : META.error(132007)) as Reply],
    ]);
    const partial: any = await service.submitTemplates(WS, USER);
    http.restore();
    expect(partial.problems).toHaveLength(1);
    expect(partial.problems[0]).toMatch(/Inglés/);
    expect(partial.channel.config.templates.es.status).toBe('PENDING');
  });

  const approvedList = [
    { id: 'a', name: 'lucilamon_fotos_listas_v1', language: 'es', status: 'APPROVED', category: 'UTILITY' },
    { id: 'b', name: 'lucilamon_fotos_listas_v1', language: 'en', status: 'APPROVED', category: 'UTILITY' },
  ];

  it('aprobada la plantilla sigue pendiente hasta que el cliente confirme que le llegó la prueba', async () => {
    const { service, scheduler } = await connected();
    let http = mockFetch([[/^GET .*\/message_templates/, { body: { data: approvedList } }]]);
    const refreshed: any = await service.refreshTemplates(WS, USER);
    http.restore();
    expect(refreshed.status).toBe('PENDING');
    expect(refreshed.changes).toHaveLength(2);

    http = mockFetch([[/^POST .*\/111222333\/messages$/, { body: { messages: [{ id: 'wamid.1' }] } }]]);
    const tested: any = await service.testWhatsApp(WS, { phone: '55 1234 5678', country: 'MX' }, USER);
    http.restore();
    expect(tested.status).toBe('PENDING');
    expect(tested.config.testSentAt).toBeTruthy();
    const sent = http.calls[0].body;
    expect(sent).toMatchObject({ to: '525512345678', type: 'template', template: { name: 'lucilamon_fotos_listas_v1', language: { code: 'es' } } });
    expect(sent.template.components[0].parameters).toHaveLength(4);

    const confirmed: any = await service.confirmWhatsAppTest(WS, true, USER);
    expect(confirmed.channel.status).toBe('ACTIVE');
    expect(scheduler.scheduleForWorkspace).toHaveBeenCalledWith(WS);
  });

  it('avisa si Meta clasificó la plantilla como Marketing (más cara)', async () => {
    const { service } = await connected();
    const http = mockFetch([[/^GET .*\/message_templates/, { body: { data: [{ ...approvedList[0], category: 'MARKETING' }] } }]]);
    const refreshed: any = await service.refreshTemplates(WS, USER);
    http.restore();
    expect(refreshed.config.templates.es.category).toBe('MARKETING');
    expect(refreshed.changes[0]).toMatchObject({ locale: 'es', to: 'APPROVED', category: 'MARKETING' });
  });

  it('la prueba con la cuenta sin método de pago explica que lo arregla el cliente en Meta, no LucilaMon', async () => {
    const { service, rows } = await connected();
    let http = mockFetch([[/^GET .*\/message_templates/, { body: { data: approvedList } }]]);
    await service.refreshTemplates(WS, USER);
    http.restore();

    http = mockFetch([[/\/messages$/, META.error(131042)]]);
    const error = await rejects(service.testWhatsApp(WS, { phone: '+52 55 1234 5678' }, USER));
    http.restore();
    expect(detail(error).code).toBe('WA_BILLING');
    expect(detail(error).message).toMatch(/método de pago/);
    expect(detail(error).action).toMatch(/no LucilaMon/);
    expect(detail(error).helpUrl).toContain('facebook.com');
    expect(rows[0].status).not.toBe('ACTIVE');
  });

  it('sin plantilla aprobada ni siquiera intenta enviar la prueba, y un teléfono inválido se rechaza', async () => {
    const { service } = await connected();
    let error = await rejects(service.testWhatsApp(WS, { phone: '+52 55 1234 5678' }, USER));
    expect(detail(error).code).toBe('WA_NO_APPROVED_TEMPLATE');

    const http = mockFetch([[/^GET .*\/message_templates/, { body: { data: approvedList } }]]);
    await service.refreshTemplates(WS, USER);
    http.restore();
    error = await rejects(service.testWhatsApp(WS, { phone: '123' }, USER));
    expect(detail(error).code).toBe('PHONE_INVALID');
  });

  it('si el cliente dice que no le llegó, recibe la lista de qué revisar, con la facturación primero', async () => {
    const { service } = await connected();
    let http = mockFetch([[/^GET .*\/message_templates/, { body: { data: approvedList } }]]);
    await service.refreshTemplates(WS, USER);
    http.restore();
    http = mockFetch([[/\/messages$/, { body: { messages: [{ id: 'w' }] } }]]);
    await service.testWhatsApp(WS, { phone: '+52 55 1234 5678' }, USER);
    http.restore();

    const result: any = await service.confirmWhatsAppTest(WS, false, USER);
    expect(result.channel.status).toBe('PENDING');
    expect(result.channel.config.testSentAt).toBeNull();
    expect(result.checklist.join(' ')).toMatch(/método de pago/);
    expect(result.checklist.length).toBeGreaterThanOrEqual(4);
  });

  it('no se puede confirmar una prueba que no se envió', async () => {
    const { service } = await connected();
    const error = await rejects(service.confirmWhatsAppTest(WS, true, USER));
    expect(detail(error).code).toBe('WA_NO_TEST');
  });

  it('una plantilla pausada por Meta pausa el canal, y una nueva aprobada lo reanuda', async () => {
    const { service, scheduler, rows } = await connected();
    let http = mockFetch([[/^GET .*\/message_templates/, { body: { data: approvedList } }], [/\/messages$/, { body: { messages: [{ id: 'w' }] } }]]);
    await service.refreshTemplates(WS, USER);
    await service.testWhatsApp(WS, { phone: '+52 55 1234 5678' }, USER);
    await service.confirmWhatsAppTest(WS, true, USER);
    http.restore();
    expect(rows[0].status).toBe('ACTIVE');

    http = mockFetch([[/^GET .*\/message_templates/, { body: { data: approvedList.map(item => ({ ...item, status: 'PAUSED' })) } }]]);
    const paused: any = await service.refreshTemplates(WS, USER);
    http.restore();
    expect(paused.status).toBe('ERROR'); // sin plantilla aprobada el canal se pausa
    expect(rows[0].status).toBe('ERROR');
    expect(rows[0].lastErrorCode).toBe('WA_TEMPLATE_PAUSED');

    scheduler.scheduleForWorkspace.mockClear();
    http = mockFetch([[/^GET .*\/message_templates/, { body: { data: [...approvedList.map(item => ({ ...item, status: 'PAUSED' })), { id: 'c', name: 'lucilamon_fotos_listas_v2', language: 'es', status: 'APPROVED', category: 'UTILITY' }] } }]]);
    await service.refreshTemplates(WS, USER);
    http.restore();
    expect(rows[0].lastErrorCode).toBeNull();
    expect(rows[0].status).toBe('ACTIVE');
    expect(scheduler.scheduleForWorkspace).toHaveBeenCalledWith(WS);
  });

  it('el cron avisa por correo al dueño cuando Meta aprueba o rechaza una plantilla', async () => {
    const { service, mailer } = await connected();
    let http = mockFetch([[/^GET .*\/message_templates/, { body: { data: [{ ...approvedList[0], status: 'PENDING' }] } }]]);
    await service.refreshTemplates(WS, USER);
    http.restore();

    http = mockFetch([[/^GET .*\/message_templates/, { body: { data: [{ ...approvedList[0], status: 'REJECTED', rejected_reason: 'INVALID_FORMAT' }] } }]]);
    const changed = await service.syncPendingTemplates();
    http.restore();
    expect(changed).toBe(1);
    expect(mailer.send).toHaveBeenCalledTimes(1);
    expect(mailer.send.mock.calls[0][0].to).toBe('duena@club.com');
    expect(mailer.send.mock.calls[0][0].html).toMatch(/rechazada/);
    expect(mailer.send.mock.calls[0][0].html).toMatch(/formato/);
  });

  it('cambiar de número descarta las plantillas y la prueba de la conexión anterior', async () => {
    const { service } = await connected(approvedList);
    const http = mockFetch([account, review, phones([phone({ id: '777' })]), noTemplates]);
    const view: any = await service.connectWhatsApp(WS, { ...dto, phoneId: '777' }, USER);
    http.restore();
    expect(view.config.templates).toEqual({});
    expect(view.config.testConfirmedAt).toBeNull();
  });

  it('desconectar borra las credenciales', async () => {
    const { service, rows } = await connected();
    await service.disconnect(WS, 'WHATSAPP', USER);
    expect(rows).toHaveLength(0);
  });
});
