"""Genera docs/partner/REFERENCE.md a partir de la especificación, para que el catálogo de endpoints
sea siempre el real. Uso: python3 scripts/partner-docs/build_reference_md.py (después de build_openapi.py)."""
import os
import sys

import yaml

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import texts_general as G  # noqa: E402
import extract as X  # noqa: E402

SPEC = yaml.safe_load(open(os.path.join(X.ROOT, 'docs', 'partner-openapi.yaml'), encoding='utf-8'))
OUT = os.path.join(X.ROOT, 'docs', 'partner', 'REFERENCE.md')

SCOPE_DOCS = {
    'events:read': 'Consultar eventos y su galería', 'events:write': 'Crear, modificar, archivar, restaurar eventos; portada y galería',
    'events:publish': 'Publicar o despublicar un evento (se suma a `events:write`)', 'events:analytics': 'Métricas del evento',
    'events:contributors': 'Listar, invitar y revocar colaboradores', 'events:sponsors': 'Catálogo de patrocinadores y su asignación a eventos',
    'photos:read': 'Fotografías, imágenes públicas y lotes de carga', 'photos:upload': 'Crear lotes, solicitar carga, confirmar y cerrar',
    'photos:review': 'Estado de publicación, dorsales a mano y cola de baja confianza', 'photos:process': 'Solicitar reprocesamiento',
    'photos:delete': 'Eliminar fotografías', 'photos:download': 'Descargas de originales, gratuitas o patrocinadas',
    'photos:bulk': 'Operaciones masivas; exige además el permiso de la acción', 'exports:read': 'Exportaciones en CSV',
    'workspace:read': 'Consultar la marca, el espacio y el consumo del contrato', 'workspace:write': 'Modificar marca, imágenes y dominio',
    'search:bib': 'Buscar por dorsal', 'search:face': 'Buscar por rostro y consultar cobertura', 'webhooks:manage': 'Suscripciones, secretos, entregas y reintentos',
    'orders:read': 'Pedidos pagados en la tienda de LucilaMon, desglose de ventas e ingresos', 'metrics:write': 'Enviar métricas de audiencia de una tienda propia',
}
ORDER = [g['name'] for g in SPEC['x-tagGroups']]


def esc(text):
    return text.replace('|', '\\|').replace('\n', ' ')


def ops_by_tag():
    out = {}
    for path, item in SPEC['paths'].items():
        for method, op in item.items():
            out.setdefault(op['tags'][0], []).append((method.upper(), path, op))
    return out


def endpoint_tables():
    groups = {g['name']: g['tags'] for g in SPEC['x-tagGroups']}
    by_tag = ops_by_tag()
    tag_desc = {t['name']: t.get('description', '') for t in SPEC['tags']}
    lines = []
    for group, tags in groups.items():
        if group in ('Primeros pasos', 'Webhooks') and not any(t in by_tag for t in tags):
            continue
        for tag in tags:
            if tag not in by_tag: continue
            lines += [f'### {tag}', '', tag_desc.get(tag, ''), '', '| Método | Ruta | Permiso | Función |', '|---|---|---|---|']
            for method, path, op in sorted(by_tag[tag], key=lambda x: (x[1], x[0])):
                scopes = ' + '.join(f'`{s}`' for s in op['x-required-scopes'])
                idem = ' Exige `Idempotency-Key`.' if any(p.get('name') == 'Idempotency-Key' for p in op.get('parameters', [])) else ''
                lines.append(f'| `{method}` | `{path}` | {scopes} | {esc(op["summary"])}.{idem} |')
            lines.append('')
    return '\n'.join(lines)


def scopes_table():
    used = {}
    for item in SPEC['paths'].values():
        for op in item.values():
            for s in op['x-required-scopes']: used[s] = used.get(s, 0) + 1
    rows = ['| Permiso | Autoriza | Operaciones |', '|---|---|---|']
    for s in sorted(SCOPE_DOCS):
        rows.append(f'| `{s}` | {SCOPE_DOCS[s]} | {used.get(s, "—")} |')
    return '\n'.join(rows)


def errors_table():
    rows = ['| Código | HTTP | Cuándo ocurre | Qué hacer |', '|---|---|---|---|']
    action = {'UNAUTHORIZED': 'Revisar o rotar la clave', 'FORBIDDEN': 'Ajustar permisos o ampliar el contrato', 'VALIDATION_ERROR': 'Corregir; no repetir igual',
              'NOT_FOUND': 'Revisar el identificador', 'CONFLICT': 'Esperar y reintentar con la misma clave, o usar otra', 'ALREADY_PROCESSED': 'Nada: ya está lista',
              'RATE_LIMITED': 'Espera creciente con jitter; respeta `Retry-After` si llega', 'PHOTO_LIMIT_REACHED': 'Ampliar el cupo con tu gestor; `details.resetsAt` indica la renovación',
              'EVENT_LIMIT_REACHED': 'Ampliar el cupo con tu gestor; `details.resetsAt` indica la renovación', 'SERVICE_UNAVAILABLE': 'Reintentar con espera creciente',
              'INTERNAL_ERROR': 'Reintentar de forma acotada; si persiste, contactar soporte'}
    for code, status, when in G.ERROR_CODES:
        rows.append(f'| `{code}` | {status} | {esc(when)} | {action[code]} |')
    return '\n'.join(rows)


TEMPLATE = """\
# Referencia funcional

> **Este documento se genera** a partir de la especificación (`docs/partner-openapi.yaml`). No lo edites a mano:
> cambia el código o los textos de `scripts/partner-docs/` y regenera. La referencia con esquemas y ejemplos de cada
> respuesta está en la página interactiva (`/developers/reference.html`).

Las rutas son relativas a `/v1/partner`. Hay **{n_ops} operaciones** y **{n_hooks} eventos de webhook**.

## Autenticación y aislamiento

Cada API key pertenece a un workspace y solo puede acceder a recursos de ese workspace. Un identificador válido de otra
cuenta responde `404`. La clave debe usarse exclusivamente desde servidores del cliente. Se envía como
`Authorization: Bearer <clave>` (o `X-API-Key`).

### Claves de prueba y de producción

Mientras tu contrato está en **piloto** recibes claves de prueba (`lm_test_…`): topes bajos, sin descarga de originales y con
fecha de fin. Al activarse el contrato dejan de valer (`403`) y debes crear claves de producción (`lm_live_…`). Nunca uses una
clave de prueba en producción ni al revés: el prefijo y el entorno registrado deben coincidir. Las claves de prueba no son un
entorno aislado: operan sobre los datos reales del espacio y solo las limitan los topes del piloto.

## Permisos (scopes)

{scopes}

Algunos permisos solo se pueden conceder si tu contrato incluye la función (webhooks, búsqueda facial, patrocinadores,
exportaciones, descargas de originales, analítica avanzada).

## Catálogo de endpoints

{endpoints}

## Cargar fotografías

1. `POST /events/{{eventId}}/upload-batches` — crea el lote (hasta 5 000 archivos). Exige `Idempotency-Key`.
2. `POST /upload-batches/{{batchId}}/files` — firma hasta 50 archivos: `clientFileId`, `fileName`, `contentType`, `sizeBytes` y `contentHash` (SHA-256 en hexadecimal).
3. `PUT` de los bytes a `uploadUrl`, con el mismo `Content-Type`. No añadas tu cabecera de API a ese `PUT`. La URL caduca a la hora.
4. `POST /upload-batches/{{batchId}}/complete` — confirma hasta 50 archivos ya subidos.
5. `POST /upload-batches/{{batchId}}/finalize` — cierra el lote; debes haber confirmado u omitido todos los archivos declarados.

Se admiten JPG y PNG, hasta 100 MB y 80 megapíxeles por archivo. Los duplicados (mismo `contentHash` en el evento) vuelven con `duplicate: true`.

## Descargas

`/download-url` es para una autorización comercial hecha por el cliente (pedido pagado en su sistema). `/download-free` aplica la
configuración pública del evento: vigencia, correo obligatorio, tope de descargas, registro de audiencia y logos de patrocinadores.
`/assets` devuelve `thumbnail`, `watermark` y `watermarkThumbnail`; para una galería pública usa solo las variantes con marca de agua.
Los originales **nunca** se exponen fuera de `/download-url` y `/bulk/download-urls`.

## Consumo del contrato

`GET /usage` devuelve, por concepto, `used`, `limit` (nulo si no hay tope), `remaining` y `percentUsed`. Las fotografías se miden por año
contractual (`windowStart`–`windowEnd`); peticiones y búsquedas faciales, por mes. Cada fotografía consume un crédito cuando su subida queda
verificada; los reintentos, los duplicados y los reprocesos no consumen otro. Al llegar al 80 % y al 100 % recibes un correo y el webhook
`usage.threshold`. Si tu contrato permite exceso, se factura lo que sobre en lugar de rechazar la subida.

## Idempotencia

`POST /events` y `POST /events/{{eventId}}/upload-batches` requieren `Idempotency-Key` de 8–200 caracteres (`A-Z a-z 0-9 . _ : -`). Durante 24 horas:

- misma operación, clave y contenido: reproduce la respuesta;
- misma clave con contenido u operación diferente: `409 CONFLICT`;
- primera solicitud aún en curso: `409 CONFLICT`; reintenta con espera creciente y la misma clave.

La validación del cuerpo ocurre antes que la idempotencia: un cuerpo inválido responde `400` aunque la clave sea nueva.

## Paginación y cursores

Los listados aceptan `page` desde 1 y `limit` de 1–100 (50 por defecto):

```json
{{"meta":{{"pagination":{{"page":1,"limit":50,"total":240,"pages":5}}}}}}
```

La búsqueda por dorsal usa `meta.cursor`. Envíalo sin modificar en la siguiente petición y termina cuando no venga.

## Errores y reintentos

```json
{{
  "error": {{ "code": "EVENT_LIMIT_REACHED", "message": "Tu contrato incluye 2 eventos al año y ya has creado 2…", "details": {{ "limit": 2, "used": 2, "resetsAt": "2027-10-28T07:57:52.803Z" }} }},
  "timestamp": "2026-10-29T07:57:56.365Z",
  "path": "/v1/partner/events"
}}
```

`message` es una lista de textos en los errores de validación. `details` solo aparece cuando hay datos útiles.

{errors}

No reintentes automáticamente `400`, `401`, `403` ni `404`. En operaciones idempotentes conserva la misma clave durante reintentos de red, `409` en curso, `429`, `503` y `5xx`.

## Límites técnicos

- General: 600 solicitudes por minuto por credencial.
- Firma y confirmación de cargas: 300 por minuto. Descargas: 120 por minuto. Búsqueda facial: 30 por minuto.
- Listados: máximo 100 elementos por página.
- Lotes: máximo 5 000 fotografías; 50 por solicitud de firma o confirmación.
- Operaciones masivas: máximo 100 fotografías.
- Portada y logo: máximo 5 MB.
- Selfie: data URL de hasta 8 000 000 caracteres; máximo operativo de 6 MB decodificados.

Los límites pueden variar por contrato. No constituyen por sí solos una garantía de capacidad ni un SLA.
"""

def update_webhooks_md():
    import json
    path = os.path.join(X.ROOT, 'docs', 'partner', 'WEBHOOKS.md')
    text = open(path, encoding='utf-8').read()
    blocks = []
    for event, item in SPEC['x-webhooks'].items():
        body = item['post']['requestBody']['content']['application/json']['example']
        blocks.append(f"### `{event}`\n\n{item['post']['description'].split(chr(10))[0]}\n\n```json\n{json.dumps(body, ensure_ascii=False, indent=2)}\n```\n")
    start, end = '<!-- payloads:start -->', '<!-- payloads:end -->'
    head, rest = text.split(start, 1)
    _, tail = rest.split(end, 1)
    open(path, 'w', encoding='utf-8').write(head + start + '\n\n' + '\n'.join(blocks) + '\n' + end + tail)
    print('WEBHOOKS.md: cargas de', len(blocks), 'eventos')


if __name__ == '__main__':
    n_ops = sum(len(v) for v in SPEC['paths'].values())
    text = TEMPLATE.format(n_ops=n_ops, n_hooks=len(SPEC['x-webhooks']), scopes=scopes_table(), endpoints=endpoint_tables(), errors=errors_table())
    open(OUT, 'w', encoding='utf-8').write(text)
    print('REFERENCE.md:', len(text.splitlines()), 'líneas,', n_ops, 'operaciones')
    update_webhooks_md()
