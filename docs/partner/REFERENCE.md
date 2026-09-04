# Referencia funcional

## Autenticación y aislamiento

Cada API key pertenece a un workspace y solo puede acceder a recursos de ese
workspace. Un identificador válido de otra cuenta responde `404`. La clave debe
usarse exclusivamente desde servidores del cliente.

## Scopes

| Scope | Autoriza |
|---|---|
| `events:read` | Consultar eventos y galería |
| `events:write` | Crear, modificar, archivar, restaurar, portada y galería |
| `events:publish` | Publicar eventos cuando la operación lo requiera |
| `events:analytics` | Métricas del evento |
| `events:contributors` | Listar, invitar y revocar colaboradores |
| `events:sponsors` | Catálogo de patrocinadores y overlays |
| `photos:read` | Fotografías, activos y lotes |
| `photos:upload` | Crear lotes, solicitar carga y confirmar archivos |
| `photos:review` | Cola de revisión, estado de publicación y dorsales manuales |
| `photos:process` | Solicitar reprocesamiento |
| `photos:delete` | Eliminar fotografías |
| `photos:download` | Descargas originales, gratuitas o patrocinadas |
| `photos:bulk` | Operaciones masivas; exige además el scope de la acción |
| `exports:read` | Exportaciones de fotos y audiencia |
| `workspace:read` | Consultar configuración de marca blanca |
| `workspace:write` | Modificar marca, activos y verificar dominio |
| `search:bib` | Buscar por dorsal |
| `search:face` | Buscar por rostro y consultar cobertura |
| `webhooks:manage` | Suscripciones, secretos, entregas y reintentos |

## Catálogo completo de endpoints

Las rutas son relativas a `/v1/partner`.

### Eventos y galería

| Método | Ruta | Scope | Función |
|---|---|---|---|
| `GET` | `/events` | `events:read` | Lista eventos; filtros `page`, `limit`, `status`, `archived` |
| `POST` | `/events` | `events:write` | Crea evento; requiere `Idempotency-Key` |
| `GET` | `/events/{eventId}` | `events:read` | Obtiene evento y configuración |
| `PATCH` | `/events/{eventId}` | `events:write` | Actualiza campos enviados |
| `DELETE` | `/events/{eventId}` | `events:write` | Archiva y despublica de forma reversible |
| `POST` | `/events/{eventId}/restore` | `events:write` | Restaura; no republica automáticamente |
| `POST` | `/events/{eventId}/cover` | `events:write` | Sube `image` multipart, máximo 5 MB |
| `DELETE` | `/events/{eventId}/cover` | `events:write` | Elimina portada |
| `GET` | `/events/{eventId}/gallery` | `events:read` | Obtiene configuración pública |
| `PATCH` | `/events/{eventId}/gallery` | `events:write` | Publicación, modo, límites, sponsor y revisión |

`PATCH /gallery` acepta `isPublished`, `commerceMode` (`PAID` o `FREE`),
`isFreeDownload`, `freeDownloadUntil`, `requireEmailForFree`,
`freeDownloadLimit`, `sponsorOverlayEnabled` y `requiresPhotoApproval`.

### Carga y fotografías

| Método | Ruta | Scope | Función |
|---|---|---|---|
| `GET` | `/events/{eventId}/upload-batches` | `photos:read` | Lista lotes paginados |
| `POST` | `/events/{eventId}/upload-batches` | `photos:upload` | Crea lote de 1–5,000; idempotente |
| `POST` | `/upload-batches/{batchId}/files` | `photos:upload` | Solicita carga para 1–50 archivos |
| `POST` | `/upload-batches/{batchId}/complete` | `photos:upload` | Confirma 1–50 archivos ya enviados |
| `GET` | `/upload-batches/{batchId}` | `photos:read` | Obtiene progreso, conteos y fallos |
| `GET` | `/events/{eventId}/photos` | `photos:read` | Lista fotos; filtros `status`, `publicationStatus` |
| `GET` | `/photos/{photoId}` | `photos:read` | Metadatos, estado y detecciones |
| `GET` | `/photos/{photoId}/assets` | `photos:read` | Previews; nunca incluye el original |
| `POST` | `/photos/{photoId}/process` | `photos:process` | Solicita reprocesamiento permitido |
| `POST` | `/photos/{photoId}/bibs` | `photos:review` | Agrega dorsal manual |
| `DELETE` | `/photos/{photoId}/bibs/{bibId}` | `photos:review` | Elimina asociación de dorsal |
| `PATCH` | `/events/{eventId}/photos/{photoId}/review` | `photos:review` | `APPROVED`, `REJECTED` o `PENDING_REVIEW` |
| `DELETE` | `/photos/{photoId}` | `photos:delete` | Elimina foto y sus activos |
| `GET` | `/events/{eventId}/bibs/low-confidence` | `photos:review` | Cola paginada; `threshold` entre 0 y 1 |

Para firmar un archivo envía `clientFileId`, `fileName`, `contentType`,
`sizeBytes` y `contentHash` SHA-256 hexadecimal. Se admiten JPEG y PNG. El PUT
debe conservar el tipo de contenido firmado.

### Búsqueda y descargas

| Método | Ruta | Scope | Función |
|---|---|---|---|
| `GET` | `/events/{eventId}/search/bib` | `search:bib` | Busca `bib`; cursor y límite máximo 100 |
| `POST` | `/events/{eventId}/search/face` | `search:face` | Data URL JPEG/PNG/WEBP y `threshold` 0.3–0.95 |
| `GET` | `/events/{eventId}/search/face/stats` | `search:face` | Cobertura de búsqueda facial |
| `POST` | `/photos/{photoId}/download-url` | `photos:download` | URL temporal del original, 60–900 s |
| `POST` | `/events/{eventId}/photos/{photoId}/download-free` | `photos:download` | Flujo gratuito limpio o patrocinado |

`/download-url` es para una autorización comercial realizada por el cliente.
`/download-free` aplica la configuración pública: vigencia, correo obligatorio,
límite, registro de audiencia, métricas y overlay patrocinado cuando corresponda.

`/assets` devuelve `thumbnail`, `watermark` y `watermarkThumbnail`. Para una
galería pública usa solo las variantes con marca de agua.

### Operaciones masivas, métricas y exportaciones

| Método | Ruta | Scopes | Función |
|---|---|---|---|
| `POST` | `/events/{eventId}/photos/bulk/review` | `photos:bulk` + `photos:review` | Revisa hasta 100 IDs |
| `POST` | `/events/{eventId}/photos/bulk/process` | `photos:bulk` + `photos:process` | Reprocesa hasta 100 IDs |
| `POST` | `/events/{eventId}/photos/bulk/delete` | `photos:bulk` + `photos:delete` | Elimina hasta 100 IDs |
| `POST` | `/events/{eventId}/photos/bulk/download-urls` | `photos:bulk` + `photos:download` | Genera hasta 100 URLs temporales |
| `GET` | `/events/{eventId}/analytics` | `events:analytics` | Conteos de procesamiento, publicación y descargas |
| `GET` | `/events/{eventId}/exports/photos` | `exports:read` | CSV en `data.content` |
| `GET` | `/events/{eventId}/exports/audience` | `exports:read` | CSV en `data.content` |

Los IDs masivos deben ser UUID únicos del mismo evento. Revisión es atómica;
procesamiento, eliminación y descarga informan el resultado por fotografía.

### Colaboradores y patrocinadores

| Método | Ruta | Scope | Función |
|---|---|---|---|
| `GET` | `/events/{eventId}/contributors` | `events:contributors` | Lista colaboradores e invitaciones |
| `POST` | `/events/{eventId}/contributors/invitations` | `events:contributors` | Invita colaborador |
| `DELETE` | `/events/{eventId}/contributors/{contributorId}` | `events:contributors` | Revoca acceso |
| `GET` | `/sponsors` | `events:sponsors` | Lista catálogo del workspace |
| `POST` | `/sponsors` | `events:sponsors` | Crea patrocinador |
| `PATCH` | `/sponsors/{sponsorId}` | `events:sponsors` | Actualiza patrocinador |
| `DELETE` | `/sponsors/{sponsorId}` | `events:sponsors` | Desactiva patrocinador |
| `GET` | `/events/{eventId}/sponsors` | `events:sponsors` | Lista overlays del evento |
| `POST` | `/events/{eventId}/sponsors` | `events:sponsors` | Vincula sponsor y placement |
| `DELETE` | `/events/{eventId}/sponsors/{sponsorId}` | `events:sponsors` | Desvincula sponsor |

El placement acepta posición `top`/`bottom`, opacidad 0.35–1, altura 2–20%,
prioridad 0–100 y si es obligatorio en descargas gratuitas.

### Marca blanca

| Método | Ruta | Scope | Función |
|---|---|---|---|
| `GET` | `/workspace` | `workspace:read` | Configuración y estado público |
| `PATCH` | `/workspace` | `workspace:write` | Nombre, slug, dominio, contacto, redes y tema |
| `POST` | `/workspace/assets/{kind}` | `workspace:write` | Sube `logo` o `cover`, máximo 5 MB |
| `DELETE` | `/workspace/assets/{kind}` | `workspace:write` | Elimina activo de marca |
| `POST` | `/workspace/domain/verify` | `workspace:write` | Comprueba la configuración del dominio |

### Webhooks

| Método | Ruta | Scope | Función |
|---|---|---|---|
| `GET` | `/webhooks` | `webhooks:manage` | Lista suscripciones sin secretos |
| `POST` | `/webhooks` | `webhooks:manage` | Crea suscripción HTTPS |
| `PATCH` | `/webhooks/{endpointId}` | `webhooks:manage` | Cambia URL, eventos o estado |
| `DELETE` | `/webhooks/{endpointId}` | `webhooks:manage` | Elimina suscripción |
| `POST` | `/webhooks/{endpointId}/rotate-secret` | `webhooks:manage` | Rota y muestra el secreto una vez |
| `GET` | `/webhooks/{endpointId}/deliveries` | `webhooks:manage` | Últimas 100 entregas |
| `POST` | `/webhooks/deliveries/{deliveryId}/retry` | `webhooks:manage` | Reprograma entrega fallida |

## Idempotencia

`POST /events` y `POST /events/{eventId}/upload-batches` requieren
`Idempotency-Key` de 8–200 caracteres. Durante 24 horas:

- misma operación, clave y contenido: reproduce la respuesta;
- misma clave con contenido u operación diferente: `409`;
- primera solicitud aún en curso: `409`, reintenta con backoff y la misma clave.

## Paginación y cursores

Los listados aceptan `page` desde 1 y `limit` de 1–100:

```json
{"meta":{"pagination":{"page":1,"limit":50,"total":240,"pages":5}}}
```

La búsqueda por dorsal usa `meta.cursor`. Envíalo sin modificar en la siguiente
petición y termina cuando sea nulo o no esté presente.

## Errores y reintentos

```json
{
  "error":{"code":"VALIDATION_ERROR","message":"Solicitud inválida","details":{}},
  "timestamp":"2026-09-03T12:00:00.000Z",
  "path":"/v1/partner/events"
}
```

| HTTP | Significado | Acción |
|---|---|---|
| `400` | Validación o estado no permitido | Corregir; no repetir igual |
| `401` | Clave ausente, inválida, expirada o revocada | Rotar/revisar clave |
| `403` | Scope o capacidad del plan insuficiente | Ajustar permisos o plan |
| `404` | Recurso inexistente o fuera del workspace | Revisar ID |
| `409` | Conflicto o idempotencia en curso/reutilizada | Resolver o reintentar con la misma clave |
| `413` | Cuerpo o archivo excede el máximo | Reducir tamaño |
| `429` | Límite temporal | Respetar `Retry-After`, backoff con jitter |
| `5xx` | Fallo temporal del servicio | Reintentar de forma acotada |

No reintentes automáticamente `400`, `401`, `403` ni `404`. En operaciones
idempotentes conserva la misma clave durante reintentos de red, `409` en curso,
`429` y `5xx`.

## Límites técnicos

- General: 600 solicitudes por minuto por credencial.
- Solicitud y confirmación de uploads: 300 por minuto.
- Descargas: 120 por minuto.
- Búsqueda facial: 30 por minuto.
- Listados: máximo 100 elementos por página.
- Lotes: máximo 5,000 fotos; grupos de upload: máximo 50.
- Operaciones masivas: máximo 100 fotos.
- Portada/logo: máximo 5 MB.
- Selfie: Data URL de hasta 8,000,000 caracteres; máximo operativo documentado: 6 MB decodificados.

Los límites pueden variar por contrato. No constituyen por sí solos una garantía
de capacidad ni SLA.
