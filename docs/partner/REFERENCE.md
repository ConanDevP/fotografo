# Referencia funcional

> **Este documento se genera** a partir de la especificación (`docs/partner-openapi.yaml`). No lo edites a mano:
> cambia el código o los textos de `scripts/partner-docs/` y regenera. La referencia con esquemas y ejemplos de cada
> respuesta está en la página interactiva (`/developers/reference.html`).

Las rutas son relativas a `/v1/partner`. Hay **73 operaciones** y **28 eventos de webhook**.

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

| Permiso | Autoriza | Operaciones |
|---|---|---|
| `events:analytics` | Métricas del evento | 8 |
| `events:contributors` | Listar, invitar y revocar colaboradores | 3 |
| `events:publish` | Publicar o despublicar un evento (se suma a `events:write`) | — |
| `events:read` | Consultar eventos y su galería | 3 |
| `events:sponsors` | Catálogo de patrocinadores y su asignación a eventos | 7 |
| `events:write` | Crear, modificar, archivar, restaurar eventos; portada y galería | 7 |
| `exports:read` | Exportaciones en CSV | 3 |
| `metrics:write` | Enviar métricas de audiencia de una tienda propia | 1 |
| `orders:read` | Pedidos pagados en la tienda de LucilaMon, desglose de ventas e ingresos | 3 |
| `photos:bulk` | Operaciones masivas; exige además el permiso de la acción | 4 |
| `photos:delete` | Eliminar fotografías | 2 |
| `photos:download` | Descargas de originales, gratuitas o patrocinadas | 3 |
| `photos:process` | Solicitar reprocesamiento | 2 |
| `photos:read` | Fotografías, imágenes públicas y lotes de carga | 5 |
| `photos:review` | Estado de publicación, dorsales a mano y cola de baja confianza | 5 |
| `photos:upload` | Crear lotes, solicitar carga, confirmar y cerrar | 4 |
| `search:bib` | Buscar por dorsal | 1 |
| `search:face` | Buscar por rostro y consultar cobertura | 2 |
| `webhooks:manage` | Suscripciones, secretos, entregas y reintentos | 7 |
| `workspace:read` | Consultar la marca, el espacio y el consumo del contrato | 2 |
| `workspace:write` | Modificar marca, imágenes y dominio | 5 |

Algunos permisos solo se pueden conceder si tu contrato incluye la función (webhooks, búsqueda facial, patrocinadores,
exportaciones, descargas de originales, analítica avanzada).

## Catálogo de endpoints

### Eventos

Crear y administrar los eventos de tu espacio. Un evento agrupa las fotografías, su precio y su galería.

| Método | Ruta | Permiso | Función |
|---|---|---|---|
| `GET` | `/events` | `events:read` | Listar eventos. |
| `POST` | `/events` | `events:write` | Crear un evento. Exige `Idempotency-Key`. |
| `DELETE` | `/events/{eventId}` | `events:write` | Archivar un evento. |
| `GET` | `/events/{eventId}` | `events:read` | Consultar un evento. |
| `PATCH` | `/events/{eventId}` | `events:write` | Actualizar un evento. |
| `DELETE` | `/events/{eventId}/cover` | `events:write` | Quitar la portada de un evento. |
| `POST` | `/events/{eventId}/cover` | `events:write` | Subir la portada de un evento. |
| `POST` | `/events/{eventId}/restore` | `events:write` | Restaurar un evento archivado. |

### Galería

Cómo se publica y se descarga el evento: publicación, modo de venta o gratuito, límites de descarga gratuita.

| Método | Ruta | Permiso | Función |
|---|---|---|---|
| `GET` | `/events/{eventId}/gallery` | `events:read` | Consultar la configuración de galería. |
| `PATCH` | `/events/{eventId}/gallery` | `events:write` | Configurar la galería. |

### Colaboradores

Invitar a fotógrafos a un evento, con su comisión y condiciones de derechos.

| Método | Ruta | Permiso | Función |
|---|---|---|---|
| `GET` | `/events/{eventId}/contributors` | `events:contributors` | Listar colaboradores del evento. |
| `POST` | `/events/{eventId}/contributors/invitations` | `events:contributors` | Invitar a un fotógrafo. |
| `DELETE` | `/events/{eventId}/contributors/{contributorId}` | `events:contributors` | Revocar un colaborador. |

### Patrocinadores

Crear patrocinadores y asignarlos a eventos para que su logo aparezca en las descargas gratuitas.

| Método | Ruta | Permiso | Función |
|---|---|---|---|
| `GET` | `/events/{eventId}/sponsors` | `events:sponsors` | Listar patrocinadores del evento. |
| `POST` | `/events/{eventId}/sponsors` | `events:sponsors` | Asignar un patrocinador al evento. |
| `GET` | `/events/{eventId}/sponsors/analytics` | `events:analytics` | Métricas de los patrocinadores del evento. |
| `DELETE` | `/events/{eventId}/sponsors/{sponsorId}` | `events:sponsors` | Quitar un patrocinador del evento. |
| `GET` | `/sponsors` | `events:sponsors` | Listar patrocinadores. |
| `POST` | `/sponsors` | `events:sponsors` | Crear un patrocinador. |
| `DELETE` | `/sponsors/{sponsorId}` | `events:sponsors` | Desactivar un patrocinador. |
| `PATCH` | `/sponsors/{sponsorId}` | `events:sponsors` | Actualizar un patrocinador. |
| `GET` | `/sponsors/{sponsorId}/analytics` | `events:analytics` | Métricas de un patrocinador. |

### Carga de fotografías

Flujo de carga por lotes con URLs firmadas: crear lote, firmar, confirmar y cerrar.

| Método | Ruta | Permiso | Función |
|---|---|---|---|
| `GET` | `/events/{eventId}/upload-batches` | `photos:read` | Listar lotes del evento. |
| `POST` | `/events/{eventId}/upload-batches` | `photos:upload` | Crear un lote de carga. Exige `Idempotency-Key`. |
| `GET` | `/upload-batches/{batchId}` | `photos:read` | Consultar el avance de un lote. |
| `POST` | `/upload-batches/{batchId}/complete` | `photos:upload` | Confirmar archivos subidos. |
| `POST` | `/upload-batches/{batchId}/files` | `photos:upload` | Firmar URLs de subida. |
| `POST` | `/upload-batches/{batchId}/finalize` | `photos:upload` | Cerrar el lote. |

### Fotografías

Consultar el estado de cada fotografía, corregir dorsales, aprobar o rechazar y reprocesar.

| Método | Ruta | Permiso | Función |
|---|---|---|---|
| `GET` | `/events/{eventId}/bibs/low-confidence` | `photos:review` | Listar dorsales con baja confianza. |
| `GET` | `/events/{eventId}/photos` | `photos:read` | Listar fotografías del evento. |
| `PATCH` | `/events/{eventId}/photos/{photoId}/review` | `photos:review` | Aprobar o rechazar una fotografía. |
| `DELETE` | `/photos/{photoId}` | `photos:delete` | Borrar una fotografía. |
| `GET` | `/photos/{photoId}` | `photos:read` | Consultar una fotografía. |
| `GET` | `/photos/{photoId}/assets` | `photos:read` | Obtener las imágenes públicas. |
| `POST` | `/photos/{photoId}/bibs` | `photos:review` | Añadir un dorsal a mano. |
| `DELETE` | `/photos/{photoId}/bibs/{bibId}` | `photos:review` | Quitar un dorsal. |
| `POST` | `/photos/{photoId}/process` | `photos:process` | Reprocesar una fotografía. |

### Descargas

Entregar archivos: enlaces temporales a los originales y descargas gratuitas con o sin patrocinador.

| Método | Ruta | Permiso | Función |
|---|---|---|---|
| `POST` | `/events/{eventId}/photos/{photoId}/download-free` | `photos:download` | Descargar una fotografía gratuita. |
| `POST` | `/photos/{photoId}/download-url` | `photos:download` | Generar un enlace temporal al original. |

### Operaciones masivas

Revisar, procesar, borrar o pedir enlaces para hasta 100 fotografías a la vez.

| Método | Ruta | Permiso | Función |
|---|---|---|---|
| `POST` | `/events/{eventId}/photos/bulk/delete` | `photos:bulk` + `photos:delete` | Borrar varias fotografías. |
| `POST` | `/events/{eventId}/photos/bulk/download-urls` | `photos:bulk` + `photos:download` | Generar enlaces temporales a varios originales. |
| `POST` | `/events/{eventId}/photos/bulk/process` | `photos:bulk` + `photos:process` | Reprocesar varias fotografías. |
| `POST` | `/events/{eventId}/photos/bulk/review` | `photos:bulk` + `photos:review` | Aprobar o rechazar varias fotografías. |

### Búsqueda

Encontrar fotografías de un corredor por dorsal o por selfie dentro de un evento.

| Método | Ruta | Permiso | Función |
|---|---|---|---|
| `GET` | `/events/{eventId}/search/bib` | `search:bib` | Buscar fotografías por dorsal. |
| `POST` | `/events/{eventId}/search/face` | `search:face` | Buscar fotografías por selfie. |
| `GET` | `/events/{eventId}/search/face/stats` | `search:face` | Estadísticas de rostros del evento. |

### Pedidos y liquidaciones

Consultar los pedidos pagados en la tienda de LucilaMon, el desglose de cada venta y las liquidaciones de tu espacio. Solo lectura: los reembolsos los gestiona el equipo de LucilaMon.

| Método | Ruta | Permiso | Función |
|---|---|---|---|
| `GET` | `/earnings` | `orders:read` | Consultar ingresos y liquidaciones. |
| `GET` | `/orders` | `orders:read` | Listar pedidos. |
| `GET` | `/orders/{orderId}` | `orders:read` | Consultar un pedido. |

### Analítica y exportaciones

Métricas del evento y exportaciones en CSV.

| Método | Ruta | Permiso | Función |
|---|---|---|---|
| `GET` | `/analytics/events` | `events:analytics` | Resumen de métricas por evento. |
| `GET` | `/analytics/overview` | `events:analytics` | Resumen de métricas del espacio. |
| `GET` | `/events/{eventId}/analytics` | `events:analytics` | Métricas del evento. |
| `POST` | `/events/{eventId}/analytics/report` | `events:analytics` | Enviar el informe del evento ahora. |
| `GET` | `/events/{eventId}/analytics/report-link` | `events:analytics` | Obtener el enlace del informe del evento. |
| `POST` | `/events/{eventId}/analytics/report-link/rotate` | `events:analytics` | Rotar el enlace del informe. |
| `GET` | `/events/{eventId}/exports/analytics` | `exports:read` | Exportar métricas en CSV. |
| `GET` | `/events/{eventId}/exports/audience` | `exports:read` | Exportar audiencia en CSV. |
| `GET` | `/events/{eventId}/exports/photos` | `exports:read` | Exportar fotografías en CSV. |
| `POST` | `/events/{eventId}/metrics` | `metrics:write` | Enviar métricas de audiencia de tu tienda. |

### Marca y dominio

Datos de tu espacio, imagen de marca y dominio propio.

| Método | Ruta | Permiso | Función |
|---|---|---|---|
| `GET` | `/workspace` | `workspace:read` | Consultar tu espacio. |
| `PATCH` | `/workspace` | `workspace:write` | Actualizar tu espacio. |
| `DELETE` | `/workspace/assets/{kind}` | `workspace:write` | Quitar el logo o la portada del espacio. |
| `POST` | `/workspace/assets/{kind}` | `workspace:write` | Subir el logo o la portada del espacio. |
| `DELETE` | `/workspace/domain` | `workspace:write` | Desconectar el dominio propio. |
| `POST` | `/workspace/domain/verify` | `workspace:write` | Verificar el dominio propio. |

### Uso y cuotas

Consumo del contrato frente a sus topes.

| Método | Ruta | Permiso | Función |
|---|---|---|---|
| `GET` | `/usage` | `workspace:read` | Consultar el consumo del contrato. |

### Webhooks

Registrar destinos, rotar secretos y revisar o reintentar entregas.

| Método | Ruta | Permiso | Función |
|---|---|---|---|
| `GET` | `/webhooks` | `webhooks:manage` | Listar webhooks. |
| `POST` | `/webhooks` | `webhooks:manage` | Registrar un webhook. |
| `POST` | `/webhooks/deliveries/{deliveryId}/retry` | `webhooks:manage` | Reintentar una entrega. |
| `DELETE` | `/webhooks/{endpointId}` | `webhooks:manage` | Eliminar un webhook. |
| `PATCH` | `/webhooks/{endpointId}` | `webhooks:manage` | Actualizar un webhook. |
| `GET` | `/webhooks/{endpointId}/deliveries` | `webhooks:manage` | Listar entregas de un webhook. |
| `POST` | `/webhooks/{endpointId}/rotate-secret` | `webhooks:manage` | Rotar el secreto de firma. |


## Cargar fotografías

1. `POST /events/{eventId}/upload-batches` — crea el lote (hasta 5 000 archivos). Exige `Idempotency-Key`.
2. `POST /upload-batches/{batchId}/files` — firma hasta 50 archivos: `clientFileId`, `fileName`, `contentType`, `sizeBytes` y `contentHash` (SHA-256 en hexadecimal).
3. `PUT` de los bytes a `uploadUrl`, con el mismo `Content-Type`. No añadas tu cabecera de API a ese `PUT`. La URL caduca a la hora.
4. `POST /upload-batches/{batchId}/complete` — confirma hasta 50 archivos ya subidos.
5. `POST /upload-batches/{batchId}/finalize` — cierra el lote; debes haber confirmado u omitido todos los archivos declarados.

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

`POST /events` y `POST /events/{eventId}/upload-batches` requieren `Idempotency-Key` de 8–200 caracteres (`A-Z a-z 0-9 . _ : -`). Durante 24 horas:

- misma operación, clave y contenido: reproduce la respuesta;
- misma clave con contenido u operación diferente: `409 CONFLICT`;
- primera solicitud aún en curso: `409 CONFLICT`; reintenta con espera creciente y la misma clave.

La validación del cuerpo ocurre antes que la idempotencia: un cuerpo inválido responde `400` aunque la clave sea nueva.

## Paginación y cursores

Los listados aceptan `page` desde 1 y `limit` de 1–100 (50 por defecto):

```json
{"meta":{"pagination":{"page":1,"limit":50,"total":240,"pages":5}}}
```

La búsqueda por dorsal usa `meta.cursor`. Envíalo sin modificar en la siguiente petición y termina cuando no venga.

## Errores y reintentos

```json
{
  "error": { "code": "EVENT_LIMIT_REACHED", "message": "Tu contrato incluye 2 eventos al año y ya has creado 2…", "details": { "limit": 2, "used": 2, "resetsAt": "2027-10-28T07:57:52.803Z" } },
  "timestamp": "2026-10-29T07:57:56.365Z",
  "path": "/v1/partner/events"
}
```

`message` es una lista de textos en los errores de validación. `details` solo aparece cuando hay datos útiles.

| Código | HTTP | Cuándo ocurre | Qué hacer |
|---|---|---|---|
| `UNAUTHORIZED` | 401 | Falta la credencial, es inválida, está revocada o caducada, o es de prueba y el contrato ya está en producción. | Revisar o rotar la clave |
| `FORBIDDEN` | 403 | La credencial no tiene el permiso necesario (el mensaje indica cuál), el contrato no incluye esa función o está suspendido o vencido. | Ajustar permisos o ampliar el contrato |
| `VALIDATION_ERROR` | 400 | El cuerpo, los parámetros o un identificador no son válidos, o la operación no se puede hacer en el estado actual del recurso. | Corregir; no repetir igual |
| `NOT_FOUND` | 404 | El recurso no existe o pertenece a otro espacio. Por seguridad no distinguimos los dos casos. | Revisar el identificador |
| `CONFLICT` | 409 | La `Idempotency-Key` ya se usó con otra petición, o la primera sigue en curso. | Esperar y reintentar con la misma clave, o usar otra |
| `ALREADY_PROCESSED` | 409 | Se pidió reprocesar una fotografía que ya está procesada. | Nada: ya está lista |
| `RATE_LIMITED` | 429 | Superaste el límite por minuto o la cuota mensual de peticiones o de búsquedas faciales. | Espera creciente con jitter; respeta `Retry-After` si llega |
| `PHOTO_LIMIT_REACHED` | 403 | La subida superaría el cupo anual de fotografías del contrato. `details` trae `limit`, `used`, `requested` y `resetsAt`. | Ampliar el cupo con tu gestor; `details.resetsAt` indica la renovación |
| `EVENT_LIMIT_REACHED` | 403 | Crear el evento superaría el cupo anual de eventos del contrato. `details` trae `limit`, `used` y `resetsAt`. | Ampliar el cupo con tu gestor; `details.resetsAt` indica la renovación |
| `SERVICE_UNAVAILABLE` | 503 | Un servicio interno no está disponible temporalmente (por ejemplo el reconocimiento facial). Reintenta con espera creciente. | Reintentar con espera creciente |
| `INTERNAL_ERROR` | 500 | Fallo inesperado de nuestro lado. Si persiste, escríbenos con la hora UTC, la ruta y el prefijo de tu clave. | Reintentar de forma acotada; si persiste, contactar soporte |

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
