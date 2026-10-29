import { readFileSync } from 'fs';
import { join } from 'path';
import * as yaml from 'js-yaml';
import { PARTNER_API_SCOPES } from './partner-api.scopes';
import { PARTNER_WEBHOOK_EVENTS } from './partner-webhook.events';

/**
 * La especificación pública (docs/partner-openapi.yaml) se genera con scripts/partner-docs/build_openapi.py.
 * Estas pruebas fallan si alguien añade, quita o cambia una ruta, un permiso o un evento de webhook sin
 * regenerarla: así la documentación nunca queda por detrás del código.
 */
const root = join(__dirname, '..', '..', '..', '..');
const spec: any = yaml.load(readFileSync(join(root, 'docs', 'partner-openapi.yaml'), 'utf8'));
const controller = readFileSync(join(__dirname, 'partner-api.controller.ts'), 'utf8');

function controllerRoutes() {
  const out: Array<{ method: string; path: string; scopes: string[] }> = [];
  const chunks = controller.split(/\n {2}(?=@(?:Get|Post|Put|Patch|Delete)\()/).slice(1);
  for (const chunk of chunks) {
    const m = /^@(Get|Post|Put|Patch|Delete)\('([^']*)'\)/.exec(chunk);
    if (!m) continue;
    const scopes = /@RequirePartnerScopes\(([^)]*)\)/.exec(chunk);
    out.push({
      method: m[1].toLowerCase(),
      path: '/' + m[2].replace(/:(\w+)/g, '{$1}'),
      scopes: scopes ? [...scopes[1].matchAll(/'([^']+)'/g)].map(x => x[1]) : [],
    });
  }
  return out;
}

describe('documentación de la Partner API', () => {
  const routes = controllerRoutes();

  it('el controlador tiene rutas (la extracción funciona)', () => {
    expect(routes.length).toBeGreaterThan(50);
  });

  it('cada ruta del controlador está documentada, con el mismo permiso', () => {
    const missing: string[] = [];
    const wrongScopes: string[] = [];
    for (const r of routes) {
      const op = spec.paths?.[r.path]?.[r.method];
      if (!op) { missing.push(`${r.method.toUpperCase()} ${r.path}`); continue; }
      if (JSON.stringify([...op['x-required-scopes']].sort()) !== JSON.stringify([...r.scopes].sort())) {
        wrongScopes.push(`${r.method.toUpperCase()} ${r.path}`);
      }
    }
    expect(missing).toEqual([]);
    expect(wrongScopes).toEqual([]);
  });

  it('no documenta rutas que ya no existen', () => {
    const known = new Set(routes.map(r => `${r.method} ${r.path}`));
    const extra: string[] = [];
    for (const [path, item] of Object.entries<any>(spec.paths)) {
      for (const method of Object.keys(item)) if (!known.has(`${method} ${path}`)) extra.push(`${method.toUpperCase()} ${path}`);
    }
    expect(extra).toEqual([]);
  });

  it('cada operación tiene resumen, descripción, respuesta correcta con ejemplo y errores', () => {
    const weak: string[] = [];
    for (const [path, item] of Object.entries<any>(spec.paths)) {
      for (const [method, op] of Object.entries<any>(item)) {
        const ok = Object.entries<any>(op.responses).find(([code]) => code.startsWith('2'));
        const hasExample = ok && ok[1].content?.['application/json']?.example !== undefined;
        if (!op.summary || !op.description || !hasExample || !op.responses['401'] || !op.responses['429']) weak.push(`${method.toUpperCase()} ${path}`);
      }
    }
    expect(weak).toEqual([]);
  });

  it('documenta los 21 permisos y los 28 eventos de webhook', () => {
    const scopesInSpec = new Set<string>();
    for (const item of Object.values<any>(spec.paths)) for (const op of Object.values<any>(item)) (op['x-required-scopes'] || []).forEach((s: string) => scopesInSpec.add(s));
    // `events:publish` no es el permiso de ninguna ruta: se suma a events:write al publicar (se documenta en el texto).
    const text = readFileSync(join(root, 'docs', 'partner-openapi.yaml'), 'utf8');
    expect(text).toContain('events:publish');
    expect([...scopesInSpec, 'events:publish'].sort()).toEqual([...PARTNER_API_SCOPES].sort());
    expect(Object.keys(spec['x-webhooks']).sort()).toEqual([...PARTNER_WEBHOOK_EVENTS].sort());
  });

  it('los ejemplos no exponen campos internos ni secretos reales', () => {
    const text = readFileSync(join(root, 'docs', 'partner-openapi.yaml'), 'utf8');
    for (const forbidden of ['stripeCustomerId', 'shareChargeIntentId', 'tokenHash', 'cloudinaryId', 'cloudflarestorage.com', 'X-Amz-Credential']) {
      expect(text).not.toContain(forbidden);
    }
    expect(text).not.toMatch(/lm_(live|test)_[a-f0-9]{16}_/); // una clave real, no el formato de ejemplo
  });
});
