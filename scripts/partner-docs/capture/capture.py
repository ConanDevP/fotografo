import json, os, subprocess, sys, time, urllib.request, urllib.error, uuid, hashlib
BASE = 'http://localhost:3333/v1/partner'
SEED = json.load(open('seed.json'))
KEY = SEED['apiKey']; WS = SEED['workspaceId']
caps = []
state = {}

def call(op, method, path, body=None, query=None, key=KEY, headers=None, raw=None, note=''):
    url = BASE + path + (('?' + '&'.join(f'{k}={v}' for k, v in query.items())) if query else '')
    h = {'Content-Type': 'application/json', 'Accept': 'application/json'}
    if key: h['Authorization'] = f'Bearer {key}'
    h.update(headers or {})
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    if raw is not None and 'Content-Type' in (headers or {}): h['Content-Type'] = headers['Content-Type']
    req = urllib.request.Request(url, data=data, method=method, headers=h)
    try:
        r = urllib.request.urlopen(req, timeout=30); status = r.status; text = r.read().decode(); rh = dict(r.headers)
    except urllib.error.HTTPError as e:
        status = e.code; text = e.read().decode(); rh = dict(e.headers)
    try: parsed = json.loads(text)
    except Exception: parsed = text[:600]
    caps.append({'op': op, 'method': method, 'path': path, 'query': query, 'request': body, 'status': status, 'response': parsed, 'headers': {k: v for k, v in rh.items() if k.lower() in ('x-ratelimit-limit','x-ratelimit-remaining','retry-after','x-request-id')}, 'note': note})
    flag = 'OK ' if status < 300 else 'ERR'
    print(f'{flag} {status} {method} {path.split("?")[0][:70]}  {op}', flush=True)
    return status, parsed

def d(resp):  # data envelope
    return resp.get('data') if isinstance(resp, dict) else None

ALL_EVENTS = ['event.created','event.updated','event.deleted','event.restored','event.cover.updated','event.cover.removed','event.gallery.updated','event.contributor.invited','event.contributor.revoked','event.sponsor.attached','event.sponsor.detached','upload.batch.created','upload.batch.completed','upload.batch.failed','photo.processing.completed','photo.processing.failed','photo.deleted','photo.reviewed','photo.download_url.created','photo.free_downloaded','photo.bulk.completed','workspace.brand.updated','analytics.report.ready','usage.threshold']
s, r = call('createWebhook (todos los eventos)', 'POST', '/webhooks', {'url': 'https://example.com/lucilamon/webhooks', 'events': ALL_EVENTS})
SINK = (d(r) or {}).get('id')
if SINK: subprocess.check_output(['node', 'hook_db.js', 'sink', SINK])
# ── workspace / usage
call('usage', 'GET', '/usage')
call('getWorkspace', 'GET', '/workspace')
call('updateWorkspace', 'PATCH', '/workspace', {'description': 'Cronometraje y fotos de carreras en el norte de Mexico.', 'contactEmail': 'hola@cronos.example', 'brand': {'primaryColor': '#3B2A7A', 'accentColor': '#D7F500', 'template': 'editorial'}})
# ── eventos
idem = str(uuid.uuid4())
s, r = call('createEvent', 'POST', '/events', {'name': 'Maraton Ciudad Demo 2027', 'date': '2027-03-14T07:00:00.000Z', 'location': 'Monterrey, Mexico', 'commerceMode': 'PAID', 'pricing': {'singlePhoto': 800, 'pack5': 3000, 'pack10': 5000, 'currency': 'USD'}, 'bibRules': {'minLen': 3, 'maxLen': 5}, 'requiresPhotoApproval': True}, headers={'Idempotency-Key': idem})
EV = d(r)['id']; state['event'] = EV
call('createEvent (repetida con la misma Idempotency-Key)', 'POST', '/events', {'name': 'Maraton Ciudad Demo 2027', 'date': '2027-03-14T07:00:00.000Z', 'location': 'Monterrey, Mexico', 'commerceMode': 'PAID', 'pricing': {'singlePhoto': 800, 'pack5': 3000, 'pack10': 5000, 'currency': 'USD'}, 'bibRules': {'minLen': 3, 'maxLen': 5}, 'requiresPhotoApproval': True}, headers={'Idempotency-Key': idem}, note='replay')
call('createEvent (misma clave, cuerpo distinto)', 'POST', '/events', {'name': 'Otro nombre distinto', 'date': '2027-03-14T07:00:00.000Z'}, headers={'Idempotency-Key': idem}, note='conflict')
call('listEvents', 'GET', '/events', query={'page': 1, 'limit': 20})
call('getEvent', 'GET', f'/events/{EV}')
call('updateEvent', 'PATCH', f'/events/{EV}', {'location': 'Parque Fundidora, Monterrey', 'requiresPhotoApproval': False})
call('getGallery', 'GET', f'/events/{EV}/gallery')
call('updateGallery', 'PATCH', f'/events/{EV}/gallery', {'isFreeDownload': True, 'requireEmailForFree': True, 'freeDownloadLimit': 500, 'sponsorOverlayEnabled': False})
call('publishEvent (modo PAID)', 'PATCH', f'/events/{EV}', {'isPublished': True})
s, r = call('createEvent (modo gratuito, publicado)', 'POST', '/events', {'name': 'Carrera Familiar Demo', 'date': '2027-05-02T08:00:00.000Z', 'location': 'Guadalajara, Mexico', 'commerceMode': 'FREE', 'isPublished': True}, headers={'Idempotency-Key': str(uuid.uuid4())})
EV2 = (d(r) or {}).get('id')
# ── fotos sembradas
out = subprocess.check_output(['node', 'seed_photos.js', EV, WS]).decode().strip()
PH = json.loads(out); state['photos'] = PH
call('listPhotos', 'GET', f'/events/{EV}/photos', query={'page': 1, 'limit': 20})
call('getPhoto', 'GET', f'/photos/{PH[0]}')
call('getPhotoAssets', 'GET', f'/photos/{PH[0]}/assets')
call('lowConfidenceBibs', 'GET', f'/events/{EV}/bibs/low-confidence', query={'threshold': 0.8})
call('addBib', 'POST', f'/photos/{PH[0]}/bibs', {'bib': '2045', 'confidence': 0.9, 'bbox': [700, 1300, 200, 110]})
s, r = call('getPhoto (tras añadir dorsal)', 'GET', f'/photos/{PH[0]}')
bibs = (d(r) or {}).get('bibs') or []
if bibs: call('removeBib', 'DELETE', f'/photos/{PH[0]}/bibs/{bibs[-1]["id"]}')
call('reviewPhoto', 'PATCH', f'/events/{EV}/photos/{PH[2]}/review', {'status': 'APPROVED', 'note': 'Dorsal confirmado a mano'})
call('processPhoto', 'POST', f'/photos/{PH[1]}/process')
call('downloadUrl', 'POST', f'/photos/{PH[0]}/download-url', {'expiresIn': 300})
if EV2:
    PH2 = json.loads(subprocess.check_output(['node', 'seed_photos.js', EV2, WS]).decode().strip())
    call('freeDownload', 'POST', f'/events/{EV2}/photos/{PH2[0]}/download-free', {'email': 'corredor@example.com', 'name': 'Ana Perez', 'bibNumber': '1001'})
call('bulkReview', 'POST', f'/events/{EV}/photos/bulk/review', {'photoIds': PH[:2], 'status': 'APPROVED'})
call('bulkProcess', 'POST', f'/events/{EV}/photos/bulk/process', {'photoIds': PH[:2]})
call('bulkDownloadUrls', 'POST', f'/events/{EV}/photos/bulk/download-urls', {'photoIds': PH[:2], 'expiresIn': 300})
# ── búsqueda
call('searchBib', 'GET', f'/events/{EV}/search/bib', query={'bib': '1001', 'limit': 20})
call('searchFace', 'POST', f'/events/{EV}/search/face', {'userImageBase64': 'data:image/jpeg;base64,' + 'A' * 200}, note='servicio facial no disponible en la captura')
call('faceStats', 'GET', f'/events/{EV}/search/face/stats')
# ── lotes de carga
BI = str(uuid.uuid4())
s, r = call('createUploadBatch', 'POST', f'/events/{EV}/upload-batches', {'totalFiles': 2}, headers={'Idempotency-Key': BI})
B = (d(r) or {}).get('id'); state['batch'] = B
h1 = hashlib.sha256(b'foto-1').hexdigest(); h2 = hashlib.sha256(b'foto-2').hexdigest()
if B:
    call('presignFiles', 'POST', f'/upload-batches/{B}/files', {'files': [{'clientFileId': 'img-0001', 'fileName': 'IMG_0001.jpg', 'contentType': 'image/jpeg', 'sizeBytes': 4200000, 'contentHash': h1}, {'clientFileId': 'img-0002', 'fileName': 'IMG_0002.jpg', 'contentType': 'image/jpeg', 'sizeBytes': 3900000, 'contentHash': h2}]})
    call('completeFiles', 'POST', f'/upload-batches/{B}/complete', {'clientFileIds': ['img-0001']}, note='el archivo no se subió a almacenamiento en esta captura')
    call('getBatch', 'GET', f'/upload-batches/{B}')
    call('finalizeBatch', 'POST', f'/upload-batches/{B}/finalize', {'skipped': [{'clientFileId': 'img-0002', 'fileName': 'IMG_0002.jpg', 'reason': 'Archivo corrupto en origen'}]})
call('listUploadBatches', 'GET', f'/events/{EV}/upload-batches', query={'page': 1, 'limit': 20})
# ── patrocinadores
s, r = call('createSponsor', 'POST', '/sponsors', {'name': 'Banco Norte', 'logoUrl': 'https://cdn.example.com/banco-norte.png', 'websiteUrl': 'https://banconorte.example.com'})
SP_ID = (d(r) or {}).get('id')
call('listSponsors', 'GET', '/sponsors')
if SP_ID:
    call('sponsorAnalytics', 'GET', f'/sponsors/{SP_ID}/analytics')
    call('updateSponsor', 'PATCH', f'/sponsors/{SP_ID}', {'name': 'Banco Norte Seguros'})
    call('attachSponsor', 'POST', f'/events/{EV}/sponsors', {'sponsorId': SP_ID, 'priority': 80, 'requiredOnFreeDownloads': True, 'placement': {'position': 'bottom', 'opacity': 0.9, 'maxHeightPercent': 8}})
    call('listEventSponsors', 'GET', f'/events/{EV}/sponsors')
    call('detachSponsor', 'DELETE', f'/events/{EV}/sponsors/{SP_ID}')
    call('removeSponsor', 'DELETE', f'/sponsors/{SP_ID}')
# ── colaboradores
s, r = call('inviteContributor', 'POST', f'/events/{EV}/contributors/invitations', {'email': 'fotografo@example.com', 'role': 'PHOTOGRAPHER', 'organizerCommissionPercent': 30, 'rightsTerms': 'El fotografo conserva la autoria; el organizador recibe 30% de cada venta.'})
call('listContributors', 'GET', f'/events/{EV}/contributors')
inv = ((d(r) or {}).get('invitation') or {}).get('id')
if inv: call('revokeContributor', 'DELETE', f'/events/{EV}/contributors/{inv}')
# ── analítica y exportaciones
call('eventAnalytics', 'GET', f'/events/{EV}/analytics')
call('analyticsEvents', 'GET', '/analytics/events')
call('exportAnalytics', 'GET', f'/events/{EV}/exports/analytics')
call('exportPhotos', 'GET', f'/events/{EV}/exports/photos')
call('exportAudience', 'GET', f'/events/{EV}/exports/audience')
# ── webhooks
s, r = call('createWebhook', 'POST', '/webhooks', {'url': 'https://example.com/lucilamon/webhooks', 'events': ['photo.processing.completed', 'upload.batch.completed', 'usage.threshold']})
WH = (d(r) or {}).get('id')
call('listWebhooks', 'GET', '/webhooks')
if WH:
    call('updateWebhook', 'PATCH', f'/webhooks/{WH}', {'events': ['photo.processing.completed', 'photo.processing.failed']})
    call('rotateWebhookSecret', 'POST', f'/webhooks/{WH}/rotate-secret')
    s, r = call('listDeliveries', 'GET', f'/webhooks/{WH}/deliveries')
    dl = (d(r) or [])
    if isinstance(dl, list) and dl: call('retryDelivery', 'POST', f'/webhooks/deliveries/{dl[0]["id"]}/retry')
    call('deleteWebhook', 'DELETE', f'/webhooks/{WH}')
# ── marca / dominio / portada
call('removeWorkspaceAsset', 'DELETE', '/workspace/assets/logo')
call('verifyDomain', 'POST', '/workspace/domain/verify')
call('disconnectDomain', 'DELETE', '/workspace/domain')
call('removeCover', 'DELETE', f'/events/{EV}/cover')
# ── borrado / restauración
call('deletePhoto', 'DELETE', f'/photos/{PH[1]}')
call('bulkDelete', 'POST', f'/events/{EV}/photos/bulk/delete', {'photoIds': [PH[2]]})
call('deleteEvent', 'DELETE', f'/events/{EV}')
call('restoreEvent', 'POST', f'/events/{EV}/restore')
# ── pedidos, liquidaciones, métricas e informes
orders = json.loads(subprocess.check_output(['node', 'hook_db.js', 'orders', WS, EV, PH[0]]).decode().strip())
call('listOrders', 'GET', '/orders', query={'page': 1, 'limit': 20})
call('getOrder', 'GET', f'/orders/{orders["paid"]}')
call('earnings', 'GET', '/earnings', query={'limit': 5})
call('recordMetrics', 'POST', f'/events/{EV}/metrics', {'events': [{'type': 'EVENT_VIEW', 'sessionId': 'sess-1', 'visitor': {'ip': '203.0.113.7', 'userAgent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', 'country': 'MX', 'referrer': 'https://www.instagram.com/'}}, {'type': 'BIB_SEARCH', 'sessionId': 'sess-1', 'metadata': {'bib': '1001'}, 'visitor': {'ip': '203.0.113.7', 'userAgent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'}}]})
call('reportLink', 'GET', f'/events/{EV}/analytics/report-link')
call('rotateReportLink', 'POST', f'/events/{EV}/analytics/report-link/rotate')
call('sendReport', 'POST', f'/events/{EV}/analytics/report')
call('eventSponsorAnalytics', 'GET', f'/events/{EV}/sponsors/analytics')
call('workspaceOverview', 'GET', '/analytics/overview')
# ── entregas de webhook con historial y topes del contrato
s, r = call('listDeliveries (con historial)', 'GET', f'/webhooks/{SINK}/deliveries')
dl = d(r)
if isinstance(dl, list) and dl: call('retryDelivery (con historial)', 'POST', f'/webhooks/deliveries/{dl[0]["id"]}/retry')
subprocess.check_output(['node', 'hook_db.js', 'limits', WS])
call('EVENT_LIMIT_REACHED', 'POST', '/events', {'name': 'Evento fuera de cupo', 'date': '2027-08-01T08:00:00.000Z'}, headers={'Idempotency-Key': str(uuid.uuid4())})
s, r = call('createUploadBatch (para probar el tope)', 'POST', f'/events/{EV2}/upload-batches', {'totalFiles': 1}, headers={'Idempotency-Key': str(uuid.uuid4())})
B2 = (d(r) or {}).get('id')
if B2: call('PHOTO_LIMIT_REACHED', 'POST', f'/upload-batches/{B2}/files', {'files': [{'clientFileId': 'img-9001', 'fileName': 'IMG_9001.jpg', 'contentType': 'image/jpeg', 'sizeBytes': 3000000, 'contentHash': hashlib.sha256(b'otra').hexdigest()}]})
# ── errores
RK = SEED['restrictedKey']
call('permiso insuficiente (scope)', 'POST', '/events', {'name': 'Evento no permitido', 'date': '2027-06-01T08:00:00.000Z'}, key=RK)
call('sin credencial', 'GET', '/events', key=None)
call('credencial inválida', 'GET', '/events', key='lm_live_0000000000000000_invalid')
call('evento inexistente', 'GET', '/events/00000000-0000-4000-8000-000000000000')
call('validación fallida', 'POST', '/events', {'name': 'x', 'date': 'ayer'})
call('uuid inválido', 'GET', '/events/not-a-uuid')
open('deliveries.json','w').write(subprocess.check_output(['node','hook_db.js','dump']).decode())
json.dump({'caps': caps, 'state': state}, open('captures.json', 'w'), ensure_ascii=False, indent=1, default=str)
print('listo', len(caps))
