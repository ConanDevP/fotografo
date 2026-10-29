import { of, lastValueFrom } from 'rxjs';
import { PartnerResponseInterceptor, stripInternalFields } from './partner-response.sanitizer';

describe('stripInternalFields', () => {
  it('quita pasarela, almacenamiento y hashes a cualquier profundidad', () => {
    const input = {
      id: 'ev1', name: 'Maratón', platformFeePercent: 15, shareChargeIntentId: 'pi_123',
      workspace: { name: 'Cronos', stripeCustomerId: 'cus_1', defaultPaymentMethodId: 'pm_1' },
      photos: [{ id: 'p1', originalUrl: 'r2://privado/x.jpg', cloudinaryId: 'abc', width: 4000 }],
      invitation: { id: 'i1', tokenHash: 'deadbeef' },
      domain: { state: 'ACTIVE', provider: 'RAILWAY', providerId: 'abc' },
    };
    const out: any = stripInternalFields(input);
    expect(out).toEqual({
      id: 'ev1', name: 'Maratón', workspace: { name: 'Cronos' },
      photos: [{ id: 'p1', width: 4000 }], invitation: { id: 'i1' },
      domain: { state: 'ACTIVE' },
    });
  });

  it('no toca lo que sí es público, incluidas fechas y decimales', () => {
    const date = new Date('2027-03-14T07:00:00Z');
    const decimal = { toJSON: () => '30' }; // como Prisma.Decimal: no es un objeto plano
    class Money { toJSON() { return '30'; } }
    const money = new Money();
    const out: any = stripInternalFields({ date, commission: money, thumbUrl: 'https://cdn/x.jpg', invitationToken: 'abc', signingSecret: 'whsec_x', decimal });
    expect(out.date).toBe(date);
    expect(out.commission).toBe(money);
    expect(out.invitationToken).toBe('abc');
    expect(out.signingSecret).toBe('whsec_x');
  });

  it('no modifica el original', () => {
    const input = { a: 1, tokenHash: 'x' };
    stripInternalFields(input);
    expect(input).toEqual({ a: 1, tokenHash: 'x' });
  });
});

describe('PartnerResponseInterceptor', () => {
  const run = (body: unknown) => lastValueFrom(new PartnerResponseInterceptor().intercept({} as any, { handle: () => of(body) } as any) as any);

  it('limpia data y conserva meta', async () => {
    const out: any = await run({ data: [{ id: 1, stripeCustomerId: 'cus' }], meta: { pagination: { page: 1 } } });
    expect(out).toEqual({ data: [{ id: 1 }], meta: { pagination: { page: 1 } } });
  });

  it('deja pasar respuestas sin data', async () => {
    expect(await run('texto')).toBe('texto');
    expect(await run({ ok: true })).toEqual({ ok: true });
  });
});
