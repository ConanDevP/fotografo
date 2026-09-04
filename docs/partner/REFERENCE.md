# Referencia y operación

## Scopes

| Scope | Operaciones |
|---|---|
| `events:read` | Listar y consultar eventos |
| `events:write` | Crear, editar y eliminar eventos |
| `events:publish` | Publicar mediante create/update |
| `events:analytics` | Metricas y analytics del evento |
| `events:contributors` | Invitaciones y colaboradores |
| `events:sponsors` | Patrocinadores y overlays |
| `photos:read` | Fotos, lotes y progreso |
| `photos:upload` | Crear lotes, firmar y confirmar archivos |
| `photos:review` | Aprobar/rechazar y corregir dorsales |
| `photos:process` | Reintentar procesamiento |
| `photos:delete` | Eliminar fotos |
| `photos:download` | Emitir URL temporal del original |
| `photos:bulk` | Operaciones masivas junto al scope especifico de la accion |
| `exports:read` | Exportaciones CSV de fotos y audiencia |
| `workspace:read` | Consultar configuracion white-label |
| `workspace:write` | Modificar branding y activos white-label |
| `search:bib` | Buscar por dorsal |
| `search:face` | Buscar por selfie y consultar estadísticas |
| `webhooks:manage` | Administrar destinos y entregas |

## Endpoints

| Método y ruta | Scope | Notas |
|---|---|---|
| `GET /events` | `events:read` | `page`, `limit` (máx. 100) |
| `POST /events` | `events:write` | Requiere `Idempotency-Key` |
| `GET /events/{eventId}` | `events:read` | Incluye configuración |
| `PATCH /events/{eventId}` | `events:write` | `events:publish` si publica |
| `DELETE /events/{eventId}` | `events:write` | Eliminación controlada existente |
| `GET /events/{eventId}/upload-batches` | `photos:read` | Lista paginada |
| `POST /events/{eventId}/upload-batches` | `photos:upload` | 1–5,000; idempotente |
| `POST /upload-batches/{batchId}/files` | `photos:upload` | 1–50 archivos |
| `POST /upload-batches/{batchId}/complete` | `photos:upload` | 1–50 IDs |
| `GET /upload-batches/{batchId}` | `photos:read` | Progreso y fallos |
| `GET /events/{eventId}/photos` | `photos:read` | Filtros `status`, `publicationStatus` |
| `GET /photos/{photoId}` | `photos:read` | Metadatos, dorsales y rostros |
| `GET /photos/{photoId}/assets` | `photos:read` | Miniatura limpia, marca completa y miniatura marcada |
| `POST /photos/{photoId}/process` | `photos:process` | Solo pendiente/fallida |
| `POST /photos/{photoId}/bibs` | `photos:review` | Dorsal manual |
| `DELETE /photos/{photoId}/bibs/{bibId}` | `photos:review` | Quita asociación |
| `PATCH /events/{eventId}/photos/{photoId}/review` | `photos:review` | `APPROVED`, `REJECTED`, `PENDING_REVIEW` |
| `DELETE /photos/{photoId}` | `photos:delete` | También libera almacenamiento contabilizado |
| `GET /events/{eventId}/search/bib` | `search:bib` | Cursor, límite máx. 100 |
| `POST /events/{eventId}/search/face` | `search:face` | Data URL JPEG/PNG/WEBP, máx. 6 MB decodificados |
| `GET /events/{eventId}/search/face/stats` | `search:face` | Cobertura facial |
| `POST /photos/{photoId}/download-url` | `photos:download` | Expiración 60–900 s |

## Variantes de imagen

## Paridad empresarial adicional

| Metodo y ruta | Scope | Notas |
|---|---|---|
| `POST/DELETE /events/{eventId}/cover` | `events:write` | Portada multipart `image`, JPG/PNG, maximo 5 MB |
| `GET/PATCH /events/{eventId}/gallery` | `events:read` / `events:write` | Publicacion, descarga gratuita, sponsors y revision |
| `POST /events/{eventId}/restore` | `events:write` | Restaura un evento archivado; no lo republica |
| `GET /events/{eventId}/bibs/low-confidence` | `photos:review` | Cola paginada con `threshold` |
| `GET/POST/DELETE /events/{eventId}/contributors...` | `events:contributors` | Lista, invita y revoca colaboradores |
| `GET/POST/PATCH /sponsors...` | `events:sponsors` | Catalogo de sponsors del workspace |
| `GET/POST/DELETE /events/{eventId}/sponsors...` | `events:sponsors` | Configura overlays del evento |
| `POST /events/{eventId}/photos/{photoId}/download-free` | `photos:download` | Flujo publico real, variante `CLEAN` o `SPONSORED` |
| `POST /events/{eventId}/photos/bulk/{review|process|delete|download-urls}` | `photos:bulk` y scope de accion | Maximo 100 fotos |
| `GET /events/{eventId}/analytics` | `events:analytics` | Procesamiento, publicacion, metricas y descargas |
| `GET /events/{eventId}/exports/{photos|audience}` | `exports:read` | CSV en `data.content` |
| `GET/PATCH /workspace` | `workspace:read` / `workspace:write` | Configuracion white-label |
| `POST/DELETE /workspace/assets/{logo|cover}` | `workspace:write` | Activos de marca multipart |
| `POST /workspace/domain/verify` | `workspace:write` | Verifica la configuracion DNS del dominio |

`DELETE /events/{eventId}` en Partner API archiva y despublica el evento. Es reversible con `/restore`.

### Descarga original frente a gratuita/patrocinada

- `/photos/{photoId}/download-url` autoriza acceso servidor-a-servidor al original; no aplica limites de audiencia ni sponsors.
- `/events/{eventId}/photos/{photoId}/download-free` reutiliza `FreeDownloadsService`: exige evento publicado `FREE`, valida email y limites, registra audiencia y metricas, y genera/cachea `SPONSORED` cuando existen overlays obligatorios activos.
- No se debe usar `/download-url` para sustituir el flujo publico gratuito: tienen finalidades distintas.

### Operaciones masivas

Los IDs deben ser unicos y pertenecer al mismo evento. Revision es atomica; procesar y eliminar devuelven resultado individual. Descarga entrega URLs temporales, no un ZIP persistente.

`GET /photos/{photoId}/assets` devuelve:

```json
{
  "data": {
    "photoId": "uuid",
    "ready": true,
    "assets": {
      "thumbnail": "https://...",
      "watermark": "https://...",
      "watermarkThumbnail": "https://..."
    }
  }
}
```

- `watermarkThumbnail`: recomendada para cuadrículas y resultados de búsqueda.
- `watermark`: vista previa grande protegida.
- `thumbnail`: derivado limpio para sistemas internos autorizados.
- El original nunca aparece aquí ni en el detalle; requiere
  `photos:download` y `/download-url`.

## Idempotencia

`POST /events` y creación de lotes exigen una clave de 8–200 caracteres:

```http
Idempotency-Key: tenant-42-event-2026-11-08
```

- El registro vive 24 horas.
- Misma clave y mismo contenido: se reproduce la respuesta.
- Misma clave y contenido/operación diferente: `409`.
- Solicitud original aún ejecutándose: `409`; reintentar con backoff.
- No reutilizar claves entre operaciones lógicas.

Los archivos usan `clientFileId` y `contentHash`. Un hash diferente no debe
reutilizar el mismo identificador.

## Paginación

```json
{"meta":{"pagination":{"page":1,"limit":50,"total":240,"pages":5}}}
```

La búsqueda por dorsal usa `meta.cursor`; omitirlo en la primera llamada y
enviarlo sin modificar en la siguiente.

## Errores

```json
{
  "error": {"code":"VALIDATION_ERROR","message":"...","details":{}},
  "timestamp":"2026-09-03T12:00:00.000Z",
  "path":"/v1/partner/..."
}
```

| HTTP | Acción del cliente |
|---|---|
| `400` | Corregir DTO, imagen, cursor o idempotencia ausente |
| `401` | Revisar/rotar credencial; no reintentar automáticamente |
| `403` | Solicitar scope; no reintentar |
| `404` | ID inexistente o perteneciente a otro workspace |
| `409` | Resolver uso de idempotencia; reintentar solo si sigue en proceso |
| `429` | Respetar `Retry-After` y aplicar jitter |
| `5xx` | Reintentar con backoff exponencial y la misma idempotency key |

## Límites vigentes

- General: 600 solicitudes/minuto por credencial.
- Firma y confirmación: 300/minuto.
- URLs de descarga: 120/minuto.
- Búsqueda facial: 30/minuto.
- Listados: máximo 100 elementos por página.
- Una selfie: máximo 6 MB decodificados y 20 megapíxeles.

Los límites protegen infraestructura y no representan una cuota comercial
garantizada. Un contrato Enterprise puede definir capacidad y SLA separados.
