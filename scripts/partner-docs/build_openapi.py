"""Genera docs/partner-openapi.yaml.

Fuentes:
  · código (extract.py): rutas, permisos, límites de tasa, cuerpos y parámetros de entrada (DTOs);
  · examples.json (sanitize.py): respuestas reales capturadas de la API;
  · texts_*.py: descripciones escritas a mano.

Uso:  python3 scripts/partner-docs/build_openapi.py
"""
import copy
import json
import os
import re
import sys

import yaml

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import extract as X  # noqa: E402
import texts_general as G  # noqa: E402
import texts_ops as T  # noqa: E402
from request_fields import REQUEST_FIELDS  # noqa: E402

OUT = os.path.join(X.ROOT, 'docs', 'partner-openapi.yaml')
EX = json.load(open(os.path.join(HERE, 'examples.json')))
UUID_RE = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', re.I)
ISO_RE = re.compile(r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$')
MISSING = set()

# ───────────────────────── tipo de respuesta por operación ─────────────────────────
# handler → (esquema, contenedor)   contenedor: object | list | paginated | cursor
RESP = {
    'listEvents': ('EventSummary', 'paginated'), 'createEvent': ('Event', 'object'), 'getEvent': ('EventDetail', 'object'),
    'updateEvent': ('Event', 'object'), 'uploadEventCover': ('Event', 'object'), 'removeEventCover': ('Event', 'object'),
    'restoreEvent': ('Event', 'object'), 'removeEvent': ('Event', 'object'),
    'getGallery': ('GalleryConfig', 'object'), 'updateGallery': ('Event', 'object'), 'lowConfidence': ('LowConfidenceBib', 'paginated'),
    'contributors': ('Contributor', 'list'), 'inviteContributor': ('ContributorInvitation', 'object'), 'revokeContributor': ('Contributor', 'object'),
    'createUploadBatch': ('UploadBatch', 'object'), 'listUploadBatches': ('UploadBatchSummary', 'paginated'),
    'presignFiles': ('PresignedFile', 'list'), 'completeFiles': ('CompleteResult', 'object'),
    'finalizeUploadBatch': ('UploadBatchJob', 'object'), 'getBatch': ('UploadBatchProgress', 'object'),
    'listPhotos': ('PhotoListItem', 'photos'), 'getPhoto': ('Photo', 'object'), 'getPhotoAssets': ('PhotoAssets', 'object'),
    'processPhoto': ('MessageResult', 'object'), 'addBib': ('PhotoBibRecord', 'object'), 'removeBib': ('MessageResult', 'object'),
    'reviewPhoto': ('PhotoRecord', 'object'), 'deletePhoto': ('MessageResult', 'object'),
    'downloadPhoto': ('DownloadUrl', 'object'), 'freeDownload': ('FreeDownload', 'object'),
    'bulkReview': ('BulkReviewResult', 'object'), 'bulkProcess': ('BulkResults', 'object'), 'bulkDelete': ('BulkResults', 'object'),
    'bulkDownload': ('BulkDownloadItem', 'list'),
    'searchByBib': ('BibSearchMatch', 'cursor'), 'searchByFace': ('FaceSearchResponse', 'face'), 'getFaceStats': ('FaceStats', 'object'),
    'analytics': ('EventAnalytics', 'object'), 'analyticsEvents': ('AnalyticsEvents', 'object'),
    'exportAnalytics': ('CsvExport', 'object'), 'exportPhotos': ('CsvExport', 'object'), 'exportAudience': ('CsvExport', 'object'),
    'listSponsors': ('SponsorWithEvents', 'list'), 'createSponsor': ('Sponsor', 'object'), 'updateSponsor': ('Sponsor', 'object'),
    'removeSponsor': ('Sponsor', 'object'), 'eventSponsors': ('EventSponsor', 'list'), 'attachSponsor': ('EventSponsor', 'object'),
    'detachSponsor': ('DetachResult', 'object'),
    'workspace': ('Workspace', 'object'), 'updateWorkspace': ('Workspace', 'object'), 'uploadWorkspaceAsset': ('WorkspaceAssets', 'object'),
    'removeWorkspaceAsset': ('WorkspaceAssets', 'object'), 'verifyWorkspaceDomain': ('DomainSetup', 'object'),
    'disconnectWorkspaceDomain': ('DomainDisconnected', 'object'),
    'listWebhooks': ('WebhookEndpoint', 'list'), 'createWebhook': ('WebhookEndpointCreated', 'object'), 'updateWebhook': ('WebhookEndpoint', 'object'),
    'deleteWebhook': ('DeletedResult', 'object'), 'rotateWebhookSecret': ('WebhookSecret', 'object'),
    'listWebhookDeliveries': ('WebhookDelivery', 'list'), 'retryWebhook': ('WebhookDeliveryFull', 'object'),
    'usage': ('Usage', 'object'),
    'listOrders': ('Order', 'paginated'), 'getOrder': ('OrderDetail', 'object'), 'earnings': ('Earnings', 'object'),
    'recordMetrics': ('MetricsRecorded', 'object'), 'reportLink': ('ReportLink', 'object'), 'rotateReportLink': ('ReportLinkRotated', 'object'),
    'sendReport': ('ReportSent', 'object'), 'eventSponsorAnalytics': ('EventSponsorAnalytics', 'object'), 'sponsorAnalytics': ('SponsorAnalytics', 'object'),
    'workspaceOverview': ('WorkspaceOverview', 'object'),
}

# Respuestas que no se pueden capturar en una API de prueba (necesitan almacenamiento, el servicio facial o DNS reales).
MANUAL_EXAMPLES = {
    'processPhoto': {'data': {'message': 'Procesamiento iniciado'}},
    'verifyWorkspaceDomain': {'data': {'domain': 'fotos.cronos.example', 'state': 'PENDING_DNS', 'certificateStatus': 'PENDING',
                                       'dnsRecords': [{'type': 'CNAME', 'name': 'fotos.cronos.example', 'value': 'cname.example.net', 'status': 'PENDING', 'currentValue': None},
                                                      {'type': 'TXT', 'name': '_verify.fotos.cronos.example', 'value': 'verify=3f9c1a7e', 'status': 'PENDING'}],
                                       'verifiedAt': None}},
    'searchByFace': {'data': {'matches': [{'photoId': '7aafef5c-b3bb-4ea0-bcfd-612bc887ba4f', 'similarity': 0.812, 'confidence': 0.99, 'faceId': 'c1f3a9e2-5d4b-4a6e-8f10-2b7c9d3e4a55',
                                           'bbox': [812, 340, 190, 230], 'thumbUrl': 'https://cdn.example.com/events/5b0c1e7e/photo-1-thumb.jpg',
                                           'watermarkUrl': 'https://cdn.example.com/events/5b0c1e7e/photo-1-wm.jpg', 'discoveryType': 'FACE_DIRECT', 'detectedBibs': ['1001']}],
                              'total': 1, 'searchTime': 412, 'userFaceDetected': True, 'confirmedBibs': ['1001'], 'inferredBibs': []},
                         'meta': {'total': 1, 'searchTime': 412}},
    'uploadEventCover': None,  # se reutiliza el ejemplo de updateEvent con imageUrl
    'uploadWorkspaceAsset': None,
}

ENUMS_BY_FIELD = {
    'commerceMode': ['PAID', 'FREE'], 'publicationStatus': ['PENDING_REVIEW', 'APPROVED', 'REJECTED'], 'variant': ['CLEAN', 'SPONSORED'],
    'position': ['top', 'bottom'], 'template': ['editorial', 'impact', 'minimal', 'cine'],
    'discoveryType': ['FACE_DIRECT', 'BIB_VIA_FACE', 'INFERRED_VIA_FACE'], 'metric': ['photos', 'apiRequests', 'faceSearches'],
}
STATUS_BY_SCHEMA = {
    'Photo': X.ENUMS['PhotoStatus'], 'PhotoListItem': X.ENUMS['PhotoStatus'], 'PhotoAssets': X.ENUMS['PhotoStatus'], 'PhotoRecord': X.ENUMS['PhotoStatus'],
    'UploadBatch': X.ENUMS['BatchUploadStatus'], 'UploadBatchSummary': X.ENUMS['BatchUploadStatus'], 'UploadBatchJob': X.ENUMS['BatchUploadStatus'],
    'UploadBatchProgress': X.ENUMS['BatchUploadStatus'],
    'Contributor': X.ENUMS['ContributorStatus'], 'EventSponsor': X.ENUMS['SponsorStatus'],
    'WebhookDelivery': ['PENDING', 'PROCESSING', 'DELIVERED', 'RETRY', 'FAILED'], 'WebhookDeliveryFull': ['PENDING', 'PROCESSING', 'DELIVERED', 'RETRY', 'FAILED'],
}
NESTED_ENUMS = {
    ('ContributorInvitation', 'status'): X.ENUMS['ContributorStatus'], ('Contributor', 'role'): X.ENUMS['EventContributorRole'],
    ('ContributorInvitation', 'role'): X.ENUMS['EventContributorRole'], ('Workspace', 'role'): X.ENUMS['WorkspaceRole'],
    ('Workspace', 'status'): X.ENUMS['MembershipStatus'], ('Usage', 'status'): X.ENUMS['EnterpriseAccountStatus'],
    ('PhotoBibRecord', 'source'): ['GEMINI', 'MANUAL'], ('BibSearchMatch', 'type'): ['DETECTED', 'INFERRED'],
    ('DomainSetup', 'state'): ['PENDING_DNS', 'PENDING_CERTIFICATE', 'ACTIVE', 'FAILED'],
    ('DomainSetup', 'type'): ['CNAME', 'TXT'],
}


# ───────────────────────── tipos de Prisma para campos nulos ─────────────────────────

def _prisma_types():
    text = open(os.path.join(X.ROOT, 'apps', 'api', 'prisma', 'schema.prisma'), encoding='utf-8').read()
    types = {}
    for m in re.finditer(r"^\s{2}(\w+)\s+(String|Int|BigInt|Decimal|Boolean|DateTime|Json|Float)(\??)[^\n]*$", text, re.M):
        name, kind, _ = m.groups()
        types.setdefault(name, kind)
    return types


PRISMA = _prisma_types()


def null_hint(name):
    if name.endswith('Pct'): return {'type': 'number'}
    if name.endswith('Cents') or name in ('fieldSize', 'freeDownloadLimit'): return {'type': 'integer'}
    if name.endswith('At') or name in ('freeDownloadUntil',): return {'type': 'string', 'format': 'date-time'}
    if name.endswith('Url'): return {'type': 'string', 'format': 'uri'}
    if name in ('bbox', 'settings', 'bibRules', 'pricing'): return {'type': 'object'}
    if name.endswith('Id') or name in ('userId', 'photographer'): return {'type': 'string', 'format': 'uuid'}
    kind = PRISMA.get(name)
    return {'Int': {'type': 'integer'}, 'Float': {'type': 'number'}, 'Boolean': {'type': 'boolean'}, 'DateTime': {'type': 'string', 'format': 'date-time'},
            'Json': {'type': 'object'}}.get(kind, {'type': 'string'})


# ───────────────────────── inferencia de esquemas a partir de ejemplos ─────────────────────────

def _scalar(v, name):
    if isinstance(v, bool): return {'type': 'boolean'}
    if isinstance(v, int): return {'type': 'integer'}
    if isinstance(v, float): return {'type': 'number'}
    if isinstance(v, str):
        if UUID_RE.match(v): return {'type': 'string', 'format': 'uuid'}
        if ISO_RE.match(v): return {'type': 'string', 'format': 'date-time'}
        if v.startswith('https://') and name.endswith(('Url', 'url')) and '<firma>' not in v: return {'type': 'string', 'format': 'uri'}
        return {'type': 'string'}
    return {}


def infer(samples, name='', schema='', top=False):
    present = [s for s in samples if s is not None]
    nullable = len(present) != len(samples)
    if not present:
        out = null_hint(name); out['nullable'] = True
        return out
    first = present[0]
    if all(isinstance(s, dict) for s in present):
        keys = []
        for s in present:
            for k in s:
                if k not in keys: keys.append(k)
        props, required = {}, []
        for k in keys:
            vals = [s.get(k) for s in present if k in s]
            props[k] = infer(vals, k, schema)
            if k in props and all(k in s for s in present): required.append(k)
            if any(k not in s for s in present):
                pass
        out = {'type': 'object', 'properties': props}
        if required: out['required'] = required
    elif all(isinstance(s, list) for s in present):
        items = [x for s in present for x in s]
        out = {'type': 'array', 'items': infer(items, name, schema) if items else {}}
    else:
        kinds = {type(s) for s in present if not isinstance(s, bool)}
        out = _scalar(first, name)
        if float in kinds and int in kinds: out = {'type': 'number'}
    if nullable: out['nullable'] = True
    return out


def describe(schema, name_path, top_schema):
    """Añade descripciones y enumeraciones recorriendo el esquema inferido."""
    if schema.get('type') == 'object' and 'properties' in schema:
        for k, sub in schema['properties'].items():
            desc = T.FIELDS.get(k)
            if desc is None and k not in ('data', 'meta'):
                MISSING.add(k)
            if desc and 'description' not in sub: sub['description'] = desc
            enum = None
            if name_path == '' and k == 'status': enum = STATUS_BY_SCHEMA.get(top_schema)
            if enum is None: enum = NESTED_ENUMS.get((top_schema, k)) or ENUMS_BY_FIELD.get(k)
            if enum and sub.get('type') == 'string' and 'enum' not in sub: sub['enum'] = enum
            describe(sub, name_path + '.' + k, top_schema)
    elif schema.get('type') == 'array' and 'items' in schema:
        describe(schema['items'], name_path + '[]', top_schema)
    return schema


# ───────────────────────── rutas y ejemplos ─────────────────────────
ROUTES = X.routes()


def route_regex(path):
    return re.compile('^' + re.sub(r'\{\w+\}', '[^/]+', path) + '$')


for r in ROUTES:
    r['re'] = route_regex(r['path'])


def handler_for(method, path):
    path = path.split('?')[0]
    hits = [r for r in ROUTES if r['method'] == method and r['re'].match(path)]
    # las rutas con segmentos literales ganan a las que usan un comodín
    hits.sort(key=lambda r: -len(re.sub(r'\{\w+\}', '', r['path'])))
    return hits[0]['handler'] if hits else None


SKIP_NOTES = ('replay', 'conflict')
OK, ERR = {}, {}
for c in EX['captures']:
    h = handler_for(c['method'], c['path'])
    if not h: continue
    bucket = OK if c['status'] < 300 else ERR
    bad = any(t in c['op'] for t in ('repetida', 'misma clave', 'para probar', '(tras', 'modo PAID', 'gratuito', 'todos los eventos', 'historial'))
    if c['status'] < 300 and not bad and h not in OK:
        OK[h] = c
    if c['status'] >= 300:
        ERR.setdefault(h, []).append(c)
# casos especiales de captura
for c in EX['captures']:
    if c['op'] == 'createEvent (modo gratuito, publicado)': OK.setdefault('_event_free', c)
    if c['op'].startswith('listDeliveries (con historial)') and c['status'] < 300: OK['listWebhookDeliveries'] = c
    if c['op'].startswith('retryDelivery (con historial)') and c['status'] < 300: OK['retryWebhook'] = c
    if c['op'] == 'createWebhook': OK['createWebhook'] = c if 'createWebhook' not in OK else OK['createWebhook']
    if c['op'] == 'getPhoto' and c['status'] < 300: OK['getPhoto'] = c


def success_example(handler):
    if handler in MANUAL_EXAMPLES and MANUAL_EXAMPLES[handler] is not None:
        return MANUAL_EXAMPLES[handler]
    if handler in ('uploadEventCover', 'removeEventCover'):
        ex = copy.deepcopy(OK['updateEvent']['response'])
        ex['data']['imageUrl'] = 'https://cdn.example.com/events/5b0c1e7e/cover.jpg' if handler == 'uploadEventCover' else None
        return ex
    if handler == 'uploadWorkspaceAsset':
        ex = copy.deepcopy(OK['removeWorkspaceAsset']['response'])
        ex['data']['logoUrl'] = 'https://cdn.example.com/workspaces/cronos/logo.png?v=1793260324'
        return ex
    return OK[handler]['response'] if handler in OK else None


def trim_example(ex):
    return ex


# ───────────────────────── componentes ─────────────────────────

def build_response_schemas():
    schemas = {}
    samples = {}
    for h, (name, kind) in RESP.items():
        ex = success_example(h)
        if ex is None or not isinstance(ex, dict) or 'data' not in ex: continue
        data = ex['data']
        if kind in ('list', 'paginated', 'cursor', 'photos'):
            elems = data if isinstance(data, list) else []
            samples.setdefault(name, []).extend(elems)
        else:
            samples.setdefault(name, []).append(data)
    # el detalle del evento incluye el espacio completo
    for name, vals in samples.items():
        if not vals: continue
        sch = infer(vals, '', name, top=True)
        sch.pop('nullable', None)
        schemas[name] = describe(sch, '', name)
    # `ledger` es un mapa tipo de asiento → centavos, no un objeto de campos fijos
    if 'WorkspaceOverview' in schemas and 'ledger' in schemas['WorkspaceOverview']['properties']:
        MISSING.difference_update({'GROSS_SALE', 'PHOTOGRAPHER_EARNING'})
        schemas['WorkspaceOverview']['properties']['ledger'] = {'type': 'object', 'additionalProperties': {'type': 'integer'}, 'description': T.FIELDS['ledger']}
    # ajustes: dorsales de getPhoto (confianza numérica) frente a addBib (decimal en texto)
    if 'PhotoBibRecord' in schemas:
        schemas['PhotoBibRecord']['properties']['confidence']['description'] = 'Confianza de 0 a 1, como decimal en texto.'
        schemas['PhotoBibRecord']['properties']['id']['description'] = 'Identificador del dorsal (número en texto).'
    return schemas


def pagination_schema():
    return {'type': 'object', 'required': ['page', 'limit', 'total', 'pages'], 'properties': {
        'page': {'type': 'integer', 'description': 'Página actual, desde 1.'}, 'limit': {'type': 'integer', 'description': 'Elementos por página.'},
        'total': {'type': 'integer', 'description': 'Total de elementos.'}, 'pages': {'type': 'integer', 'description': 'Total de páginas.'}}}


def envelope(name, kind):
    ref = {'$ref': f'#/components/schemas/{name}'}
    if kind == 'object':
        return {'type': 'object', 'required': ['data'], 'properties': {'data': ref}}
    if kind == 'list':
        return {'type': 'object', 'required': ['data'], 'properties': {'data': {'type': 'array', 'items': ref}}}
    if kind == 'paginated':
        return {'type': 'object', 'required': ['data', 'meta'], 'properties': {'data': {'type': 'array', 'items': ref},
                'meta': {'type': 'object', 'properties': {'pagination': {'$ref': '#/components/schemas/Pagination'}}}}}
    if kind == 'photos':
        return {'type': 'object', 'required': ['data', 'meta'], 'properties': {'data': {'type': 'array', 'items': ref}, 'meta': {'type': 'object', 'properties': {
            'pagination': {'$ref': '#/components/schemas/Pagination'}, 'total': {'type': 'integer', 'description': 'Fotografías del evento.'},
            'pending': {'type': 'integer', 'description': 'Fotografías pendientes de procesar.'}, 'processed': {'type': 'integer', 'description': 'Fotografías procesadas.'},
            'failed': {'type': 'integer', 'description': 'Fotografías cuyo procesamiento falló.'}}}}}
    if kind == 'cursor':
        return {'type': 'object', 'required': ['data'], 'properties': {'data': {'type': 'array', 'items': ref}, 'meta': {'type': 'object', 'properties': {
            'total': {'type': 'integer', 'description': 'Coincidencias en total.'}, 'cursor': {'type': 'string', 'nullable': True, 'description': 'Cursor de la página siguiente; ausente o nulo en la última.'}}}}}
    if kind == 'face':
        return {'type': 'object', 'required': ['data'], 'properties': {'data': ref, 'meta': {'type': 'object', 'properties': {
            'total': {'type': 'integer'}, 'searchTime': {'type': 'integer', 'description': 'Milisegundos que tardó la búsqueda.'}}}}}
    raise ValueError(kind)


def error_components():
    err = {'type': 'object', 'required': ['error', 'timestamp', 'path'], 'properties': {
        'error': {'type': 'object', 'required': ['code', 'message'], 'properties': {
            'code': {'type': 'string', 'description': 'Código estable para tu lógica. Ver el catálogo en la sección Errores.', 'enum': [c[0] for c in G.ERROR_CODES]},
            'message': {'oneOf': [{'type': 'string'}, {'type': 'array', 'items': {'type': 'string'}}], 'description': 'Texto para diagnóstico. En errores de validación es una lista.'},
            'details': {'type': 'object', 'additionalProperties': True, 'description': 'Datos adicionales cuando existen, por ejemplo `limit`, `used` y `resetsAt` en los topes del contrato.'}}},
        'timestamp': {'type': 'string', 'format': 'date-time', 'description': 'Cuándo se produjo el error.'},
        'path': {'type': 'string', 'description': 'Ruta de la petición.'}}}
    return err


def err_example(label):
    for c in EX['captures']:
        if c['op'] == label: return c['response']
    raise KeyError(label)


RATE_EXAMPLE = {'error': {'code': 'RATE_LIMITED', 'message': 'Cuota mensual de solicitudes API agotada'}, 'timestamp': '2026-10-29T07:47:31.681Z', 'path': '/v1/partner/events'}


def error_responses():
    def resp(desc, example, name='ejemplo'):
        return {'description': desc, 'content': {'application/json': {'schema': {'$ref': '#/components/schemas/ErrorResponse'}, 'examples': {name: {'value': example}}}}}
    return {
        'BadRequest': resp('Petición inválida: el cuerpo, un parámetro o un identificador no cumplen las reglas, o el recurso no está en un estado que permita la operación.', err_example('validación fallida'), 'validacion'),
        'Unauthorized': resp('Falta la credencial, es inválida, está revocada o caducada.', err_example('sin credencial'), 'sin_credencial'),
        'Forbidden': resp('La credencial no tiene el permiso necesario, o el contrato no incluye la función o la suspendió.', err_example('permiso insuficiente (scope)'), 'falta_permiso'),
        'NotFound': resp('El recurso no existe o pertenece a otro espacio.', err_example('evento inexistente'), 'no_existe'),
        'Conflict': resp('Conflicto con una petición anterior o con el estado del recurso.', err_example('createEvent (misma clave, cuerpo distinto)'), 'idempotency_key_reutilizada'),
        'TooManyRequests': resp('Superaste el límite por minuto o una cuota mensual del contrato.', RATE_EXAMPLE, 'cuota_mensual'),
        'ServiceUnavailable': resp('Un servicio interno no está disponible temporalmente. Reintenta con espera creciente.', err_example('searchFace'), 'reconocimiento_facial'),
    }


# Parámetros de consulta que cada listado realmente aplica (el resto del DTO compartido se ignora).
QUERY_USED = {
    'listEvents': {'page', 'limit', 'archived'},
    'listUploadBatches': {'page', 'limit'},
    'listPhotos': {'page', 'limit', 'status', 'publicationStatus'},
    'lowConfidence': {'page', 'limit', 'threshold'},
}

# ───────────────────────── operaciones ─────────────────────────

def dto_components(names):
    out, queue = {}, list(names)
    while queue:
        n = queue.pop()
        if n in out or n not in X.BLOCKS: continue
        sch, deps = X.dto_schema(n)
        for k, p in sch['properties'].items():
            d = T.FIELDS.get(k) if False else None
            d = REQUEST_FIELDS.get((n, k)) or REQUEST_FIELDS.get(k)
            if d is None: MISSING.add(f'{n}.{k}')
            if d and 'description' not in p and '$ref' not in p: p['description'] = d
            elif d and '$ref' in p: p['description'] = d
        out[n] = sch
        queue.extend(deps)
    return out


def param_schema(name):
    if name == 'bibId': return {'type': 'string', 'pattern': '^\\d+$'}
    if name == 'kind': return {'type': 'string', 'enum': ['logo', 'cover']}
    return {'type': 'string', 'format': 'uuid'}


def operation(r):
    h = r['handler']
    tag, summary, description = T.OPS[h]
    scopes = r['scopes']
    lim, per = r['limit']
    extra = [f"**Permiso requerido:** {' y '.join('`' + s + '`' for s in scopes)}." if scopes else '']
    if h == 'createEvent': extra[0] += ' Para publicar al crear, además `events:publish`.'
    extra.append(f'**Límite:** {lim} peticiones por minuto por credencial.')
    op = {'operationId': h, 'tags': [tag], 'summary': summary, 'description': description + '\n\n' + '\n\n'.join(e for e in extra if e),
          'x-required-scopes': scopes, 'x-rate-limit': {'requests': lim, 'perSeconds': per}}
    params = []
    for name in re.findall(r'\{(\w+)\}', r['path']):
        params.append({'name': name, 'in': 'path', 'required': True, 'description': T.PARAMS[name], 'schema': param_schema(name)})
    if r['query_dto']:
        qs, _ = X.dto_schema(r['query_dto'])
        allowed = QUERY_USED.get(h)  # los listados comparten un DTO, pero cada uno usa solo parte de sus filtros
        for k, sch in qs['properties'].items():
            if allowed is not None and k not in allowed:
                continue
            p = {'name': k, 'in': 'query', 'required': k in qs.get('required', []), 'schema': sch}
            if k in T.PARAMS: p['description'] = T.PARAMS[k]
            else: MISSING.add(f'param:{k}')
            params.append(p)
    if r['idempotent']:
        params.append({'name': 'Idempotency-Key', 'in': 'header', 'required': True, 'description': 'Clave única por operación lógica (8 a 200 caracteres: letras, números y `. _ : -`). Reintentar con la misma clave devuelve la respuesta original.',
                       'schema': {'type': 'string', 'minLength': 8, 'maxLength': 200, 'pattern': '^[A-Za-z0-9._:-]+$'}, 'example': '0b6f6a5e-7a8c-4f4e-9b1d-2a3c4e5f6a7b'})
    if params: op['parameters'] = params
    cap = OK.get(h)
    if r['body_dto']:
        body = {'required': True, 'content': {'application/json': {'schema': {'$ref': f"#/components/schemas/{r['body_dto']}"}}}}
        if cap and cap.get('request') is not None:
            body['content']['application/json']['example'] = cap['request']
        op['requestBody'] = body
    elif r['file_field']:
        op['requestBody'] = {'required': True, 'content': {'multipart/form-data': {'schema': {'type': 'object', 'required': [r['file_field']], 'properties': {
            r['file_field']: {'type': 'string', 'format': 'binary', 'description': 'Imagen JPG o PNG, hasta 5 MB.'}}}}}}
    # respuestas
    name, kind = RESP[h]
    status = (cap['status'] if cap else (201 if r['method'] == 'POST' else 200))
    ex = success_example(h)
    ok = {'description': 'Operación correcta.', 'content': {'application/json': {'schema': envelope(name, kind)}}}
    if ex is not None: ok['content']['application/json']['example'] = ex
    responses = {str(status): ok}
    has_ids = '{' in r['path']
    if r['body_dto'] or r['query_dto'] or has_ids or r['file_field']:
        responses['400'] = {'$ref': '#/components/responses/BadRequest'}
    responses['401'] = {'$ref': '#/components/responses/Unauthorized'}
    responses['403'] = {'$ref': '#/components/responses/Forbidden'}
    if h == 'createEvent':
        responses['403'] = _with_example('Forbidden', 'EVENT_LIMIT_REACHED', err_example('EVENT_LIMIT_REACHED'), 'cupo_de_eventos')
    if h == 'presignFiles':
        responses['403'] = _with_example('Forbidden', 'PHOTO_LIMIT_REACHED', err_example('PHOTO_LIMIT_REACHED'), 'cupo_de_fotografias')
    if has_ids: responses['404'] = {'$ref': '#/components/responses/NotFound'}
    if r['idempotent']: responses['409'] = {'$ref': '#/components/responses/Conflict'}
    if h == 'processPhoto':
        responses['409'] = _with_example('Conflict', 'ALREADY_PROCESSED', err_example('processPhoto'), 'ya_procesada')
    responses['429'] = {'$ref': '#/components/responses/TooManyRequests'}
    if h == 'searchByFace': responses['503'] = {'$ref': '#/components/responses/ServiceUnavailable'}
    op['responses'] = dict(sorted(responses.items()))
    op['security'] = [{'PartnerApiKey': []}, {'ApiKeyHeader': []}]
    return op


_EXTRA = {}


def _with_example(base, name, example, key):
    """Respuesta de error con un ejemplo adicional específico de la operación."""
    ref = f'{base}_{name}'
    if ref not in _EXTRA:
        resp = copy.deepcopy(error_responses()[base])
        resp['content']['application/json']['examples'] = {key: {'value': example}}
        _EXTRA[ref] = resp
    return {'$ref': f'#/components/responses/{ref}'}


# ───────────────────────── webhooks ─────────────────────────

def webhook_section():
    out = {}
    for event, desc in G.WEBHOOKS.items():
        captured = EX['webhooks'].get(event)
        data = captured['data'] if captured else G.WEBHOOK_MANUAL_PAYLOADS[event]
        data_schema = describe(infer([data], '', 'Webhook'), '', 'Webhook')
        data_schema.pop('nullable', None)
        envelope_example = {'id': captured['id'] if captured else '0b6f6a5e-7a8c-4f4e-9b1d-2a3c4e5f6a7b', 'type': event,
                            'createdAt': captured['createdAt'] if captured else '2027-03-14T09:12:44.318Z', 'data': data}
        out[event] = {'post': {
            'operationId': 'webhook_' + event.replace('.', '_'), 'tags': ['Eventos de webhook'], 'summary': event, 'description': desc +
            '\n\nTu endpoint recibe un `POST` con el cuerpo de abajo y las cabeceras `x-lucilamon-signature`, `x-lucilamon-timestamp` y `x-lucilamon-event-id`. Responde `2xx` en menos de 10 segundos.',
            'requestBody': {'required': True, 'content': {'application/json': {'schema': {'type': 'object', 'required': ['id', 'type', 'createdAt', 'data'], 'properties': {
                'id': {'type': 'string', 'format': 'uuid', 'description': 'Identificador único del evento. Es el mismo en los reintentos: úsalo para no procesar dos veces.'},
                'type': {'type': 'string', 'enum': [event], 'description': 'Tipo de evento.'},
                'createdAt': {'type': 'string', 'format': 'date-time', 'description': 'Cuándo se generó el evento.'},
                'data': data_schema}}, 'example': envelope_example}}},
            'responses': {'2XX': {'description': 'Entrega aceptada. Cualquier otra respuesta, o no responder a tiempo, provoca un reintento.'}}}}
    return out


# ───────────────────────── ensamblado ─────────────────────────

def errors_section():
    rows = ['| Código | HTTP | Cuándo ocurre |', '|---|---|---|'] + [f'| `{c}` | {s} | {w} |' for c, s, w in G.ERROR_CODES]
    return '\n'.join(rows)


def scopes_section():
    rows = ['| Permiso | Qué permite | Operaciones |', '|---|---|---|']
    by = {}
    for r in ROUTES:
        for s in r['scopes']: by.setdefault(s, []).append(f"`{r['method']} {r['path']}`")
    docs = {
        'events:read': 'Leer eventos y su galería.', 'events:write': 'Crear, editar, archivar y restaurar eventos; portada.', 'events:publish': 'Publicar o despublicar un evento (se suma a `events:write`).',
        'events:analytics': 'Consultar métricas de eventos.', 'events:contributors': 'Invitar y revocar fotógrafos.', 'events:sponsors': 'Gestionar patrocinadores y asignarlos a eventos.',
        'photos:read': 'Consultar fotografías y lotes de carga.', 'photos:upload': 'Crear lotes y firmar, confirmar y cerrar cargas.', 'photos:review': 'Aprobar o rechazar fotografías y corregir dorsales.',
        'photos:process': 'Reprocesar fotografías.', 'photos:delete': 'Borrar fotografías.', 'photos:download': 'Generar enlaces a originales y descargas gratuitas.',
        'photos:bulk': 'Operaciones masivas (se suma al permiso de la operación).', 'exports:read': 'Exportaciones en CSV.', 'workspace:read': 'Leer tu espacio y el consumo del contrato.',
        'workspace:write': 'Editar marca, imágenes y dominio.', 'search:bib': 'Buscar por dorsal.', 'search:face': 'Buscar por selfie.', 'webhooks:manage': 'Registrar y administrar webhooks.',
        'orders:read': 'Consultar pedidos, desglose de ventas y liquidaciones.', 'metrics:write': 'Enviar métricas de audiencia de tu tienda propia.'}
    for s in sorted(by):
        rows.append(f'| `{s}` | {docs[s]} | {len(by[s])} |')
    return '\n'.join(rows)


def build():
    paths = {}
    dto_names = set()
    for r in ROUTES:
        paths.setdefault(r['path'], {})[r['method'].lower()] = operation(r)
        for n in (r['body_dto'],):
            if n: dto_names.add(n)
    schemas = {}
    schemas.update(dto_components(dto_names))
    schemas.update(build_response_schemas())
    schemas['Pagination'] = pagination_schema()
    schemas['ErrorResponse'] = error_components()
    responses = error_responses()
    responses.update(_EXTRA)
    tags = [{'name': n, 'description': d} for n, d in G.TAGS]
    tags.append({'name': 'Eventos de webhook', 'description': 'Los 28 eventos que puedes recibir. Cada uno llega como `POST` a tu URL con el sobre `{ id, type, createdAt, data }`.'})
    tags.append({'name': 'Errores', 'x-displayName': 'Errores', 'description': 'Todas las respuestas de error tienen la misma forma (ver la introducción). Estos son los códigos:\n\n' + errors_section()})
    tags.append({'name': 'Permisos', 'x-displayName': 'Permisos (scopes)', 'description': 'Cada credencial lleva solo los permisos que le des. Algunos solo se pueden conceder si el contrato incluye la función.\n\n' + scopes_section()})
    spec = {
        'openapi': '3.0.3',
        'info': {'title': 'LucilaMon Partner API', 'version': G.VERSION, 'description': G.INTRO,
                 'contact': {'name': 'Soporte para integradores', 'email': 'empresas@lucilamon.com'},
                 'license': {'name': 'Propietaria: uso sujeto a los Términos de Servicio de LucilaMon', 'url': 'https://lucilamon.com/terms'}},
        'servers': [{'url': 'https://api.lucilamon.com/v1/partner', 'description': 'Producción (claves `lm_live_`). Las claves de prueba del piloto usan la misma URL.'}],
        'security': [{'PartnerApiKey': []}, {'ApiKeyHeader': []}],
        'tags': tags,
        'x-tagGroups': [
            {'name': 'Primeros pasos', 'tags': ['Errores', 'Permisos']},
            {'name': 'Eventos y galería', 'tags': ['Eventos', 'Galería', 'Colaboradores', 'Patrocinadores']},
            {'name': 'Fotografías', 'tags': ['Carga de fotografías', 'Fotografías', 'Descargas', 'Operaciones masivas', 'Búsqueda']},
            {'name': 'Negocio', 'tags': ['Pedidos y liquidaciones', 'Analítica y exportaciones', 'Marca y dominio', 'Uso y cuotas']},
            {'name': 'Webhooks', 'tags': ['Webhooks', 'Eventos de webhook']},
        ],
        'paths': dict(sorted(paths.items())),
        'x-webhooks': webhook_section(),
        'components': {
            'securitySchemes': {
                'PartnerApiKey': {'type': 'http', 'scheme': 'bearer', 'bearerFormat': 'lm_live_… / lm_test_…', 'description': 'Clave de API en `Authorization: Bearer <clave>`.'},
                'ApiKeyHeader': {'type': 'apiKey', 'in': 'header', 'name': 'X-API-Key', 'description': 'Alternativa a `Authorization`.'}},
            'responses': responses,
            'schemas': dict(sorted(schemas.items())),
        },
    }
    return rename_schemas(spec, {r['body_dto'] for r in ROUTES if r['body_dto']})


def friendly(name, bodies):
    n = name.replace('Partner', '')
    if n.endswith('Dto'):
        n = n[:-3] + ('Request' if name in bodies else '')
    return n


def rename_schemas(spec, bodies):
    """Nombres legibles: CreateEventDto → CreateEventRequest, BibRulesDto → BibRules."""
    mapping = {k: friendly(k, bodies) for k in spec['components']['schemas']}

    def walk(v):
        if isinstance(v, dict):
            out = {}
            for k, x in v.items():
                if k == '$ref' and isinstance(x, str) and x.startswith('#/components/schemas/'):
                    out[k] = '#/components/schemas/' + mapping.get(x.split('/')[-1], x.split('/')[-1])
                else:
                    out[k] = walk(x)
            return out
        if isinstance(v, list):
            return [walk(x) for x in v]
        return v
    spec = walk(spec)
    spec['components']['schemas'] = dict(sorted((mapping.get(k, k), v) for k, v in spec['components']['schemas'].items()))
    return spec


class Dumper(yaml.SafeDumper):
    pass


def _str(dumper, data):
    if '\n' in data:
        return dumper.represent_scalar('tag:yaml.org,2002:str', data, style='|')
    return dumper.represent_scalar('tag:yaml.org,2002:str', data)


Dumper.add_representer(str, _str)
Dumper.ignore_aliases = lambda self, data: True


if __name__ == '__main__':
    spec = build()
    with open(OUT, 'w', encoding='utf-8') as f:
        f.write('# GENERADO por scripts/partner-docs/build_openapi.py — no editar a mano.\n')
        yaml.dump(spec, f, Dumper=Dumper, allow_unicode=True, sort_keys=False, width=120)
    print('operaciones:', sum(len(v) for v in spec['paths'].values()), '| esquemas:', len(spec['components']['schemas']), '| webhooks:', len(spec['x-webhooks']))
    if MISSING:
        print('SIN DESCRIPCIÓN:', ', '.join(sorted(MISSING)))
