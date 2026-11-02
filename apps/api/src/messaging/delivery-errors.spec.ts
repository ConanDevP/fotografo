import { classifyResendError, classifyWhatsAppError } from './delivery-errors';

const meta = (code: number, extra: Record<string, unknown> = {}) => ({ error: { code, message: 'x', ...extra } });

describe('errores de Resend', () => {
  it('dominio sin verificar y remitente de pruebas son un problema de la cuenta del cliente', () => {
    for (const message of [
      'The yourdomain.com domain is not verified. Please, add and verify your domain on https://resend.com/domains',
      'You can only send testing emails to your own email address (a@b.co). To send emails to other recipients, please verify a domain.',
    ]) {
      const result = classifyResendError(403, { name: 'validation_error', message });
      expect(result).toMatchObject({ scope: 'ACCOUNT', code: 'EMAIL_DOMAIN_NOT_VERIFIED' });
      expect(result.action).toMatch(/Resend/);
    }
  });

  it('clave inválida, revocada o restringida', () => {
    expect(classifyResendError(401, { name: 'invalid_api_key' })).toMatchObject({ scope: 'ACCOUNT', code: 'EMAIL_KEY_INVALID' });
    expect(classifyResendError(401, { name: 'restricted_api_key' })).toMatchObject({ code: 'EMAIL_KEY_RESTRICTED' });
    expect(classifyResendError(401, {})).toMatchObject({ code: 'EMAIL_KEY_INVALID' });
  });

  it('las cuotas se reintentan más tarde y dicen de quién es el límite', () => {
    const daily = classifyResendError(429, { name: 'daily_quota_exceeded' });
    expect(daily).toMatchObject({ scope: 'LIMIT', code: 'EMAIL_DAILY_QUOTA' });
    expect(daily.retryAfterMs).toBeGreaterThanOrEqual(60 * 60_000);
    expect(daily.message).toMatch(/Resend/);
    expect(classifyResendError(429, { name: 'rate_limit_exceeded' }).retryAfterMs).toBeLessThan(10 * 60_000);
  });

  it('un correo de corredor inválido solo descarta ese aviso', () => {
    expect(classifyResendError(422, { name: 'validation_error', message: 'Invalid `to` field.' }).scope).toBe('RECIPIENT');
  });

  it('una caída o un error que no conocemos se reintenta', () => {
    expect(classifyResendError(500, { name: 'internal_server_error' }).scope).toBe('TRANSIENT');
    expect(classifyResendError(undefined, null).scope).toBe('TRANSIENT');
    expect(classifyResendError(418, { name: 'raro' }).scope).toBe('TRANSIENT');
  });
});

describe('errores de WhatsApp (Meta)', () => {
  it('sin método de pago (131042) es de la cuenta del cliente y lo dice con claridad', () => {
    const result = classifyWhatsAppError(400, meta(131042));
    expect(result).toMatchObject({ scope: 'ACCOUNT', code: 'WA_BILLING' });
    expect(result.message).toMatch(/método de pago/);
    expect(result.action).toMatch(/no LucilaMon/);
    expect(result.helpUrl).toContain('facebook.com');
  });

  it('token vencido o sin permiso', () => {
    expect(classifyWhatsAppError(401, meta(190))).toMatchObject({ scope: 'ACCOUNT', code: 'WA_TOKEN_INVALID' });
    expect(classifyWhatsAppError(400, meta(10))).toMatchObject({ scope: 'ACCOUNT', code: 'WA_PERMISSION' });
    expect(classifyWhatsAppError(400, meta(200))).toMatchObject({ code: 'WA_PERMISSION' });
  });

  it('número de prueba de Meta (131030)', () => {
    expect(classifyWhatsAppError(400, meta(131030))).toMatchObject({ scope: 'ACCOUNT', code: 'WA_TEST_NUMBER' });
  });

  it('un teléfono sin WhatsApp solo descarta ese aviso', () => {
    expect(classifyWhatsAppError(400, meta(131026))).toMatchObject({ scope: 'RECIPIENT', code: 'WA_UNDELIVERABLE' });
    expect(classifyWhatsAppError(400, meta(131049)).scope).toBe('RECIPIENT');
  });

  it('plantilla rechazada, pausada o con otro formato pausa el canal', () => {
    for (const code of [132000, 132001, 132007, 132012, 132015, 132016]) {
      expect(classifyWhatsAppError(400, meta(code)).scope).toBe('TEMPLATE');
    }
  });

  it('los límites de ritmo se reintentan más tarde', () => {
    for (const code of [130429, 131056, 80007, 131048]) {
      const result = classifyWhatsAppError(429, meta(code));
      expect(result.scope).toBe('LIMIT');
      expect(result.retryAfterMs).toBeGreaterThan(0);
    }
  });

  it('el 100 distingue un ID inexistente de otras peticiones mal formadas', () => {
    expect(classifyWhatsAppError(400, meta(100, { error_subcode: 33 }))).toMatchObject({ scope: 'ACCOUNT', code: 'WA_ID_NOT_FOUND' });
    expect(classifyWhatsAppError(400, meta(100, { message: 'Unsupported get request. Object with ID does not exist' })).code).toBe('WA_ID_NOT_FOUND');
    expect(classifyWhatsAppError(400, meta(100, { message: 'Invalid parameter' })).code).toBe('WA_BAD_REQUEST');
  });

  it('caídas y errores desconocidos se reintentan, nunca pausan el canal', () => {
    expect(classifyWhatsAppError(500, null).scope).toBe('TRANSIENT');
    expect(classifyWhatsAppError(undefined, null).scope).toBe('TRANSIENT');
    expect(classifyWhatsAppError(400, meta(999999)).scope).toBe('TRANSIENT');
    expect(classifyWhatsAppError(400, meta(131016)).scope).toBe('TRANSIENT');
  });

  it('todo mensaje trae un texto legible y un código estable', () => {
    for (const code of [190, 10, 131042, 131031, 131030, 131026, 132015, 130429, 100, 2, 999]) {
      const result = classifyWhatsAppError(400, meta(code));
      expect(result.message.length).toBeGreaterThan(15);
      expect(result.code).toMatch(/^WA_[A-Z_]+$/);
    }
  });
});
