# LucilaMon Partner API v1

> Documentación empresarial completa: [índice](partner/README.md),
> [inicio rápido](partner/QUICKSTART.md), [referencia](partner/REFERENCE.md),
> [webhooks](partner/WEBHOOKS.md) y [producción](partner/PRODUCTION.md).

API servidor-a-servidor para que un workspace administre eventos y cargue
fotografías desde sistemas externos. Esta API no reemplaza la Storefront API y
las credenciales nunca deben incluirse en JavaScript del navegador.

## Base URL

```text
https://<api-host>/v1/partner
```

## Crear una credencial

Un `OWNER` o `ADMIN` del workspace crea la credencial usando su sesión normal:

```http
POST /v1/workspaces/{workspaceId}/api-clients
Authorization: Bearer <jwt-del-dashboard>
Content-Type: application/json

{
  "name": "Integración de carrera",
  "scopes": ["events:read", "events:write", "photos:read", "photos:upload"]
}
```

La respuesta contiene `apiKey` una sola vez. LucilaMon guarda únicamente su
hash. Si se pierde, hay que rotarla:

```http
POST   /v1/workspaces/{workspaceId}/api-clients/{clientId}/rotate
DELETE /v1/workspaces/{workspaceId}/api-clients/{clientId}
```

## Autenticación

```http
Authorization: Bearer lm_live_<prefijo>_<secreto>
```

También se acepta `X-API-Key`, pero `Authorization` es el mecanismo recomendado.
Una clave queda inválida al revocarse, expirar, eliminarse el workspace o perder
su creador el acceso al workspace.

## Scopes

| Scope | Capacidad |
|---|---|
| `events:read` | Listar y consultar eventos |
| `events:write` | Crear y editar eventos |
| `events:publish` | Publicar un evento mediante create/update |
| `photos:read` | Consultar fotos y estado de lotes |
| `photos:upload` | Crear lotes, firmar y confirmar archivos |
| `photos:review` | Reservado para revisión de fotos |

## Operaciones empresariales

La API no valida pagos ni pedidos del consumidor final. El cliente decide cuándo
autorizar una descarga; LucilaMon autentica la integración, aplica el scope y
garantiza que el recurso pertenezca a su workspace.

- `GET|POST /events` y `GET|PATCH|DELETE /events/{eventId}`
- `GET /events/{eventId}/photos`, `GET /photos/{photoId}` y `GET /photos/{photoId}/assets`
- `POST /photos/{photoId}/process`
- `POST|DELETE /photos/{photoId}/bibs[/{bibId}]`
- `PATCH /events/{eventId}/photos/{photoId}/review`
- `GET /events/{eventId}/search/bib?bib=123`
- `POST /events/{eventId}/search/face`
- `GET /events/{eventId}/search/face/stats`
- `POST /photos/{photoId}/download-url`

Scopes adicionales: `photos:process`, `photos:delete`, `photos:download`,
`search:bib` y `search:face`. Los enlaces de originales expiran entre 60 y 900
segundos; nunca se devuelve una URL permanente del bucket privado.

`/photos/{photoId}/assets` devuelve `thumbnail`, `watermark` y
`watermarkThumbnail`. Usa la miniatura marcada en cuadrículas, la marca completa
en vistas previas y reserva `/download-url` exclusivamente para el original.

## Flujo de carga

Las operaciones que crean recursos (`POST /events` y creación de lotes) exigen
`Idempotency-Key`. Debe ser estable por intento lógico; repetirla durante 24
horas devuelve la primera respuesta y evita duplicados.

### 1. Crear lote

```http
POST /v1/partner/events/{eventId}/upload-batches
Authorization: Bearer <api-key>
Content-Type: application/json

{ "totalFiles": 2 }
```

### 2. Solicitar URLs firmadas

```http
POST /v1/partner/upload-batches/{batchId}/files
Authorization: Bearer <api-key>
Content-Type: application/json

{
  "files": [{
    "clientFileId": "camera-a-IMG_001",
    "fileName": "IMG_001.jpg",
    "contentType": "image/jpeg",
    "sizeBytes": 1820344,
    "contentHash": "<sha256 hexadecimal de 64 caracteres>"
  }]
}
```

Sube cada archivo con `PUT` directamente a su `uploadUrl`, usando exactamente el
`Content-Type` firmado. Reutilizar `clientFileId` y `contentHash` hace seguro el
reintento y evita duplicados.

### 3. Confirmar

```http
POST /v1/partner/upload-batches/{batchId}/complete
Authorization: Bearer <api-key>
Content-Type: application/json

{ "clientFileIds": ["camera-a-IMG_001"] }
```

LucilaMon verifica objeto, tamaño, firma de imagen y dimensiones antes de
encolarlo. Una URL firmada por sí sola no registra una foto como válida.

### 4. Consultar procesamiento

```http
GET /v1/partner/upload-batches/{batchId}
Authorization: Bearer <api-key>
```

## Eventos y fotos

```http
GET   /v1/partner/events?page=1&limit=50
POST  /v1/partner/events
GET   /v1/partner/events/{eventId}
PATCH /v1/partner/events/{eventId}
GET   /v1/partner/events/{eventId}/photos?page=1&limit=50
```

Todos los identificadores se vuelven a comprobar contra el workspace de la
credencial. Un ID perteneciente a otro cliente responde como no encontrado.

## Webhooks salientes

Una credencial con `webhooks:manage` puede registrar destinos HTTPS:

```http
POST /v1/partner/webhooks
Authorization: Bearer <api-key>
Content-Type: application/json

{
  "url": "https://cliente.example/webhooks/lucilamon",
  "events": ["photo.processing.completed", "photo.processing.failed", "upload.batch.completed"]
}
```

`signingSecret` se muestra una sola vez. También existen:

```text
GET    /webhooks
PATCH  /webhooks/{endpointId}
DELETE /webhooks/{endpointId}
POST   /webhooks/{endpointId}/rotate-secret
GET    /webhooks/{endpointId}/deliveries
POST   /webhooks/deliveries/{deliveryId}/retry
```

Eventos soportados: `event.created`, `event.updated`, `event.deleted`,
`upload.batch.created`, `upload.batch.completed`, `upload.batch.failed`,
`photo.processing.completed`, `photo.processing.failed`, `photo.deleted` y
`photo.download_url.created`.

Cada solicitud contiene `x-lucilamon-event-id`, `x-lucilamon-timestamp` y
`x-lucilamon-signature: v1=<hex>`. Para verificarla calcula HMAC-SHA256 con el
secreto sobre `<timestamp>.<cuerpo JSON exacto>`, compara en tiempo constante y
rechaza timestamps con más de cinco minutos. El `event-id` permite deduplicar.

LucilaMon considera entregado cualquier `2xx`. Aplica timeout de 10 segundos,
no sigue redirecciones y reintenta hasta ocho veces con backoff exponencial.
Las URLs privadas, locales o sin HTTPS son rechazadas para impedir SSRF.

## Errores

```json
{
  "error": {
    "code": "FORBIDDEN",
    "message": "Falta el permiso API: photos:upload"
  },
  "timestamp": "2026-09-02T12:00:00.000Z",
  "path": "/v1/partner/upload-batches/.../files"
}
```

`401` significa clave ausente, inválida, expirada o inactiva; `403` significa
que la clave es válida pero carece del scope requerido; `404` no confirma si un
recurso existe en otro workspace; `429` requiere respetar `Retry-After`.
