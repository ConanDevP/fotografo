import { MailService } from './mail.service';

function build() {
  const config: any = { get: (key: string, fallback?: unknown) => ({ RESEND_API_KEY: 're_test', EMAIL_FROM: 'avisos@lucilamon.com' }[key] ?? fallback) };
  const sent: any[] = [];
  const realFetch = global.fetch;
  global.fetch = jest.fn(async (_url: any, init: any) => {
    sent.push(JSON.parse(init.body));
    return { ok: true, text: async () => '' } as any;
  }) as any;
  return { service: new MailService(config), sent, restore: () => { global.fetch = realFetch; } };
}

const input = {
  to: 'ana@example.com', locale: 'es' as const, name: 'Ana', bib: '123', eventName: 'Maratón <CDMX>',
  previews: ['https://cdn/a-wm.jpg', 'https://cdn/b-wm.jpg'], totalPhotos: 9,
  eventUrl: 'https://lucilamon.com/s/ws/eventos/maraton?bib=123',
  unsubscribeUrl: 'https://lucilamon.com/r/baja?t=abc',
  unsubscribePostUrl: 'https://api.lucilamon.com/v1/public/registrations/unsubscribe?t=abc',
};

describe('correo de aviso agrupado', () => {
  it('lleva baja de un clic en las cabeceras y en el pie', async () => {
    const { service, sent, restore } = build();
    await service.sendRunnerDigest(input);
    restore();

    expect(sent[0].headers['List-Unsubscribe']).toBe(`<${input.unsubscribePostUrl}>, <${input.unsubscribeUrl}>`);
    expect(sent[0].headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(sent[0].html).toContain('Darme de baja');
    expect(sent[0].html).toContain(input.unsubscribeUrl);
    expect(sent[0].to).toEqual(['ana@example.com']);
  });

  it('muestra solo vistas con marca de agua, el total y cuántas faltan', async () => {
    const { service, sent, restore } = build();
    await service.sendRunnerDigest(input);
    restore();

    expect(sent[0].html).toContain('9 fotos nuevas del dorsal 123');
    expect(sent[0].html).toContain('https://cdn/a-wm.jpg');
    expect(sent[0].html).toContain('y 7 más');
    expect(sent[0].subject).toContain('Maratón <CDMX>'); // el asunto es texto plano, no HTML
  });

  it('escapa el HTML de lo que escribe el organizador o el corredor', async () => {
    const { service, sent, restore } = build();
    await service.sendRunnerDigest({ ...input, name: '<script>alert(1)</script>' });
    restore();

    expect(sent[0].html).not.toContain('<script>');
    expect(sent[0].html).toContain('Maratón &lt;CDMX&gt;');
  });

  it('sale en inglés cuando el corredor se registró en inglés, y sin POST si no hay URL pública', async () => {
    const { service, sent, restore } = build();
    await service.sendRunnerDigest({ ...input, locale: 'en', totalPhotos: 1, previews: ['https://cdn/a.jpg'], unsubscribePostUrl: undefined });
    restore();

    expect(sent[0].subject).toContain('are ready');
    expect(sent[0].html).toContain('1 new photo of bib 123');
    expect(sent[0].html).toContain('Unsubscribe');
    expect(sent[0].headers['List-Unsubscribe']).toBe(`<${input.unsubscribeUrl}>`);
    expect(sent[0].headers).not.toHaveProperty('List-Unsubscribe-Post');
  });
});
