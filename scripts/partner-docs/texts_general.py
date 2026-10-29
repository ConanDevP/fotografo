"""Textos generales de la especificación: introducción, etiquetas, errores y webhooks."""

VERSION = '1.5.0'

INTRO = """\
API servidor a servidor para operar eventos de fotografía deportiva: crear eventos, cargar y procesar
fotografías, buscar por dorsal o por rostro, entregar descargas, gestionar patrocinadores, leer métricas y
recibir avisos por webhook. Tu sistema conserva la relación con el comprador: puedes usar tu propio checkout
y tu propia pasarela de pago, y pedir el enlace de descarga cuando el pago esté confirmado.

## Empezar

1. Pide acceso (piloto de 30 días con claves de prueba, sin compromiso) desde el panel o escribiendo a ventas.
2. Crea una credencial en **Panel → API e integraciones** y elige solo los permisos (*scopes*) que necesites.
3. Guarda la clave en el gestor de secretos de tu servidor. **Nunca** la pongas en una app móvil ni en JavaScript del navegador.
4. Llama a la API con la cabecera `Authorization: Bearer <clave>`.

```bash
curl https://api.lucilamon.com/v1/partner/events \\
  -H "Authorization: Bearer $LUCILAMON_API_KEY"
```

## Autenticación y entornos

- `Authorization: Bearer <clave>` (recomendado) o `X-API-Key: <clave>`.
- Las claves empiezan por `lm_live_` (producción) o `lm_test_` (piloto). **Las claves de prueba dejan de funcionar
  cuando el contrato pasa a producción**: ese día se crean claves `lm_live_`. Las de prueba usan los mismos datos
  y las mismas rutas; lo único que las limita son los topes bajos del piloto.
- Cada clave lleva una lista de permisos. Una operación sin el permiso necesario responde `403 FORBIDDEN`
  con el permiso que falta. Algunos permisos solo se pueden conceder si tu contrato incluye esa función
  (webhooks, búsqueda facial, patrocinadores, exportaciones, descargas de originales, analítica avanzada).
- La clave se muestra **una sola vez** al crearla o rotarla. Si se compromete, rótala desde el panel: la anterior deja
  de valer al instante.

## Formato de las respuestas

Toda respuesta correcta es JSON con la forma `{ "data": ..., "meta": ... }`. Las listas paginadas traen
`meta.pagination` con `page`, `limit`, `total` y `pages`. Fechas en ISO 8601 (UTC). Identificadores UUID,
salvo los dorsales detectados, cuyo `id` es un número en texto.

Los errores tienen siempre la misma forma:

```json
{
  "error": { "code": "VALIDATION_ERROR", "message": ["La fecha debe ser válida"] },
  "timestamp": "2026-10-29T07:47:31.681Z",
  "path": "/v1/partner/events"
}
```

`code` es estable y pensado para tu lógica; `message` es para diagnóstico y puede cambiar (en errores de validación es
una lista de textos). Algunos errores añaden `details` con datos útiles, por ejemplo `limit`, `used` y `resetsAt` cuando
se alcanza un tope del contrato. Ver el catálogo completo en [Errores](#section/Errores).

## Paginación

Los listados aceptan `page` (desde 1) y `limit` (de 1 a 100, 50 por defecto). La búsqueda por dorsal usa cursor:
pasa `meta.cursor` de la respuesta anterior en el parámetro `cursor`.

## Idempotencia

`POST /events` y `POST /events/{eventId}/upload-batches` **exigen** la cabecera `Idempotency-Key` (8 a 200 caracteres
de `A-Z a-z 0-9 . _ : -`). Si reintentas la misma petición con la misma clave en 24 horas, recibes la respuesta original
y no se crea nada nuevo. La misma clave con otro cuerpo responde `409 CONFLICT`; si la primera sigue en curso, también `409`.
Usa un UUID nuevo por cada operación lógica.

## Límites de uso

- **Por minuto y por credencial:** 600 peticiones en general. Más estrictos: 300 en las firmas y confirmaciones de carga,
  120 en las descargas y 30 en la búsqueda facial. Al excederlos recibes `429 RATE_LIMITED`.
- **Cuotas del contrato:** peticiones al mes, búsquedas faciales al mes, fotografías al año, eventos al año, credenciales
  y webhooks activos. Consulta tu consumo en `GET /usage`. Al agotar peticiones o búsquedas recibes `429`; al agotar
  fotografías o eventos, `403 PHOTO_LIMIT_REACHED` o `403 EVENT_LIMIT_REACHED`. Al llegar al 80 % y al 100 % te avisamos por correo y
  con el webhook `usage.threshold`.

## Cargar fotografías

La carga no pasa por nuestros servidores: subes los archivos directamente a una URL firmada.

1. `POST /events/{eventId}/upload-batches` crea el lote e indica cuántos archivos vas a subir (hasta 5 000).
2. `POST /upload-batches/{batchId}/files` firma hasta 50 archivos por llamada. Cada archivo lleva su `contentHash` SHA-256;
   si esa foto ya existe en el evento, la respuesta trae `duplicate: true` y no hay que subirla.
3. Sube cada archivo con `PUT` a su `uploadUrl`, con el mismo `Content-Type` que declaraste. La URL caduca a la hora.
4. `POST /upload-batches/{batchId}/complete` confirma hasta 50 archivos subidos; verificamos que existan y los ponemos a procesar.
5. `POST /upload-batches/{batchId}/finalize` cierra el lote. Debes reportar todos los archivos declarados: los confirmados y los
   que omites (con el motivo).
6. Sigue el avance con `GET /upload-batches/{batchId}` o con los webhooks `photo.processing.completed` y `upload.batch.completed`.

Formatos admitidos: JPG y PNG, hasta 100 MB por archivo y 80 megapíxeles.

## Webhooks

Registra una URL HTTPS y elige los eventos. Cada entrega es un `POST` con esta cabecera de firma:

```
x-lucilamon-signature: v1=<HMAC-SHA256 hexadecimal>
x-lucilamon-timestamp: <segundos Unix>
x-lucilamon-event-id:  <id del evento>
```

La firma es `HMAC_SHA256(signingSecret, "<timestamp>.<cuerpo crudo>")`. Verifícala con el cuerpo **sin reformatear** y
rechaza marcas de tiempo con más de 5 minutos de diferencia. Responde `2xx` en menos de 10 segundos; si no, reintentamos
con espera creciente hasta 8 veces. Los reintentos llevan el mismo `x-lucilamon-event-id`: úsalo para no procesar dos veces.
Los 28 eventos y sus cargas están en la sección **Webhooks** de esta referencia.

## Pagos

Tienes tres formas de cobrar: con **tu propio checkout y pasarela** (tú cobras y pides el enlace al original cuando el pago esté confirmado),
con **nuestra tienda** (Stripe o PayPal, con la comisión de tu plan) o con **descarga gratuita y patrocinadores**. Se elige por evento.
Con tu pasarela, mantén el evento sin publicar: las búsquedas y las descargas por API funcionan igual. Si usas nuestra tienda, consulta los pedidos y las liquidaciones en
`/orders` y `/earnings` y recibe los avisos `order.*`; los reembolsos los gestiona el equipo de LucilaMon. Guía completa: `docs/partner/PAGOS.md`.

## Versionado

La versión mayor va en la URL (`/v1`). Dentro de `v1` podemos añadir campos opcionales, valores de enumeraciones y eventos
nuevos: tu cliente debe ignorar lo que no conozca y no depender del orden de las propiedades.
"""

TAGS = [
    ('Eventos', 'Crear y administrar los eventos de tu espacio. Un evento agrupa las fotografías, su precio y su galería.'),
    ('Galería', 'Cómo se publica y se descarga el evento: publicación, modo de venta o gratuito, límites de descarga gratuita.'),
    ('Carga de fotografías', 'Flujo de carga por lotes con URLs firmadas: crear lote, firmar, confirmar y cerrar.'),
    ('Fotografías', 'Consultar el estado de cada fotografía, corregir dorsales, aprobar o rechazar y reprocesar.'),
    ('Descargas', 'Entregar archivos: enlaces temporales a los originales y descargas gratuitas con o sin patrocinador.'),
    ('Operaciones masivas', 'Revisar, procesar, borrar o pedir enlaces para hasta 100 fotografías a la vez.'),
    ('Búsqueda', 'Encontrar fotografías de un corredor por dorsal o por selfie dentro de un evento.'),
    ('Colaboradores', 'Invitar a fotógrafos a un evento, con su comisión y condiciones de derechos.'),
    ('Patrocinadores', 'Crear patrocinadores y asignarlos a eventos para que su logo aparezca en las descargas gratuitas.'),
    ('Analítica y exportaciones', 'Métricas del evento y exportaciones en CSV.'),
    ('Marca y dominio', 'Datos de tu espacio, imagen de marca y dominio propio.'),
    ('Pedidos y liquidaciones', 'Consultar los pedidos pagados en la tienda de LucilaMon, el desglose de cada venta y las liquidaciones de tu espacio. Solo lectura: los reembolsos los gestiona el equipo de LucilaMon.'),
    ('Webhooks', 'Registrar destinos, rotar secretos y revisar o reintentar entregas.'),
    ('Uso y cuotas', 'Consumo del contrato frente a sus topes.'),
]

# código → (HTTP, cuándo ocurre)
ERROR_CODES = [
    ('UNAUTHORIZED', 401, 'Falta la credencial, es inválida, está revocada o caducada, o es de prueba y el contrato ya está en producción.'),
    ('FORBIDDEN', 403, 'La credencial no tiene el permiso necesario (el mensaje indica cuál), el contrato no incluye esa función o está suspendido o vencido.'),
    ('VALIDATION_ERROR', 400, 'El cuerpo, los parámetros o un identificador no son válidos, o la operación no se puede hacer en el estado actual del recurso.'),
    ('NOT_FOUND', 404, 'El recurso no existe o pertenece a otro espacio. Por seguridad no distinguimos los dos casos.'),
    ('CONFLICT', 409, 'La `Idempotency-Key` ya se usó con otra petición, o la primera sigue en curso.'),
    ('ALREADY_PROCESSED', 409, 'Se pidió reprocesar una fotografía que ya está procesada.'),
    ('RATE_LIMITED', 429, 'Superaste el límite por minuto o la cuota mensual de peticiones o de búsquedas faciales.'),
    ('PHOTO_LIMIT_REACHED', 403, 'La subida superaría el cupo anual de fotografías del contrato. `details` trae `limit`, `used`, `requested` y `resetsAt`.'),
    ('EVENT_LIMIT_REACHED', 403, 'Crear el evento superaría el cupo anual de eventos del contrato. `details` trae `limit`, `used` y `resetsAt`.'),
    ('SERVICE_UNAVAILABLE', 503, 'Un servicio interno no está disponible temporalmente (por ejemplo el reconocimiento facial). Reintenta con espera creciente.'),
    ('INTERNAL_ERROR', 500, 'Fallo inesperado de nuestro lado. Si persiste, escríbenos con la hora UTC, la ruta y el prefijo de tu clave.'),
]

# Eventos de webhook: descripción y de dónde sale la carga.
WEBHOOKS = {
    'event.created': 'Se creó un evento.',
    'event.updated': 'Se actualizó un evento (datos, precio, publicación).',
    'event.deleted': 'Se archivó un evento (borrado lógico; se puede restaurar).',
    'event.restored': 'Se restauró un evento archivado.',
    'event.cover.updated': 'Se subió o reemplazó la portada del evento.',
    'event.cover.removed': 'Se quitó la portada del evento.',
    'event.gallery.updated': 'Cambió la configuración de galería: publicación, descargas gratuitas, patrocinadores.',
    'event.contributor.invited': 'Se invitó a un fotógrafo al evento.',
    'event.contributor.revoked': 'Se revocó la invitación o el acceso de un fotógrafo.',
    'event.sponsor.attached': 'Se asignó un patrocinador al evento.',
    'event.sponsor.detached': 'Se quitó un patrocinador del evento.',
    'upload.batch.created': 'Se creó un lote de carga.',
    'upload.batch.completed': 'El lote terminó de procesarse.',
    'upload.batch.failed': 'El lote terminó con errores que impiden completarlo.',
    'photo.processing.completed': 'Una fotografía terminó de procesarse: ya tiene miniatura, marca de agua y dorsales leídos.',
    'photo.processing.failed': 'El procesamiento de una fotografía falló tras agotar los reintentos.',
    'photo.deleted': 'Se borró una fotografía.',
    'photo.reviewed': 'Se aprobó o rechazó una fotografía.',
    'photo.download_url.created': 'Se generó un enlace temporal al original.',
    'photo.free_downloaded': 'Alguien descargó una fotografía gratuita.',
    'photo.bulk.completed': 'Terminó una operación masiva sobre fotografías.',
    'workspace.brand.updated': 'Cambió la marca, el dominio o los datos de tu espacio.',
    'analytics.report.ready': 'El informe posterior al evento está listo.',
    'usage.threshold': 'El consumo del contrato cruzó el 80 % o el 100 % de un tope.',
    'order.paid': 'Un pedido de tu evento se pagó en la tienda de LucilaMon. Se emite una sola vez por pedido.',
    'order.refunded': 'Un pedido de tu evento se reembolsó (por ti con nuestro equipo, o por la pasarela).',
    'order.disputed': 'El banco del comprador abrió un contracargo. Se corta el acceso a la descarga mientras dure.',
    'order.dispute.closed': 'Se resolvió el contracargo: `disputeOutcome` es `won` (el pedido vuelve a `PAID`) o `lost` (queda `REFUNDED`).',
}

# Cargas de los eventos que no se pueden provocar llamando a la API (los emite un proceso en segundo plano).
# Se escriben a mano a partir del código que los emite.
WEBHOOK_MANUAL_PAYLOADS = {
    'event.cover.updated': {'eventId': '5b0c1e7e-4d3a-4f6e-9a21-8c7d2e1f0a11', 'imageUrl': 'https://cdn.example.com/events/5b0c1e7e/cover.jpg'},
    'event.cover.removed': {'eventId': '5b0c1e7e-4d3a-4f6e-9a21-8c7d2e1f0a11'},
    'upload.batch.completed': {'batchId': '2a6e0f55-1c0d-4b77-8f42-3d1b9c7a5e10', 'eventId': '5b0c1e7e-4d3a-4f6e-9a21-8c7d2e1f0a11', 'status': 'COMPLETED', 'totalFiles': 480, 'processedFiles': 480, 'failedItems': 0},
    'upload.batch.failed': {'batchId': '2a6e0f55-1c0d-4b77-8f42-3d1b9c7a5e10', 'eventId': '5b0c1e7e-4d3a-4f6e-9a21-8c7d2e1f0a11', 'status': 'FAILED', 'totalFiles': 480, 'processedFiles': 441, 'failedItems': 39},
    'photo.processing.completed': {'photoId': '7aafef5c-b3bb-4ea0-bcfd-612bc887ba4f', 'eventId': '5b0c1e7e-4d3a-4f6e-9a21-8c7d2e1f0a11', 'status': 'PROCESSED', 'processingCompletedAt': '2027-03-14T09:12:44.318Z'},
    'photo.processing.failed': {'photoId': '7aafef5c-b3bb-4ea0-bcfd-612bc887ba4f', 'eventId': '5b0c1e7e-4d3a-4f6e-9a21-8c7d2e1f0a11', 'status': 'FAILED', 'error': 'No se pudo generar la versión con marca de agua'},
    'analytics.report.ready': {'eventId': '5b0c1e7e-4d3a-4f6e-9a21-8c7d2e1f0a11', 'name': 'Maratón Ciudad Demo 2027', 'reportUrl': 'https://app.example.com/report/9f2c1b7e', 'computedAt': '2027-03-15T08:00:03.000Z'},
    'order.paid': {"id": "a3c1e5f7-2b4d-4c6e-8a90-1b2c3d4e5f60", "eventId": "5b0c1e7e-4d3a-4f6e-9a21-8c7d2e1f0a11", "eventName": "Maratón Ciudad Demo 2027", "status": "PAID", "amountCents": 800, "currency": "USD", "paymentGateway": "STRIPE", "buyerEmail": "corredor@example.com", "itemCount": 1, "paidAt": "2027-03-14T10:02:11.000Z", "refundedAt": None, "disputedAt": None, "disputeOutcome": None, "settlementStatus": "PENDING", "settledAt": None, "createdAt": "2027-03-14T10:01:40.000Z"},
    'order.refunded': {"id": "a3c1e5f7-2b4d-4c6e-8a90-1b2c3d4e5f60", "eventId": "5b0c1e7e-4d3a-4f6e-9a21-8c7d2e1f0a11", "eventName": "Maratón Ciudad Demo 2027", "status": "REFUNDED", "amountCents": 800, "currency": "USD", "paymentGateway": "STRIPE", "buyerEmail": "corredor@example.com", "itemCount": 1, "paidAt": "2027-03-14T10:02:11.000Z", "refundedAt": "2027-03-15T09:00:00.000Z", "disputedAt": None, "disputeOutcome": None, "settlementStatus": "NOT_REQUIRED", "settledAt": None, "createdAt": "2027-03-14T10:01:40.000Z"},
    'order.disputed': {"id": "a3c1e5f7-2b4d-4c6e-8a90-1b2c3d4e5f60", "eventId": "5b0c1e7e-4d3a-4f6e-9a21-8c7d2e1f0a11", "eventName": "Maratón Ciudad Demo 2027", "status": "DISPUTED", "amountCents": 800, "currency": "USD", "paymentGateway": "STRIPE", "buyerEmail": "corredor@example.com", "itemCount": 1, "paidAt": "2027-03-14T10:02:11.000Z", "refundedAt": None, "disputedAt": "2027-03-20T12:00:00.000Z", "disputeOutcome": "needs_response", "settlementStatus": "PENDING", "settledAt": None, "createdAt": "2027-03-14T10:01:40.000Z"},
    'order.dispute.closed': {"id": "a3c1e5f7-2b4d-4c6e-8a90-1b2c3d4e5f60", "eventId": "5b0c1e7e-4d3a-4f6e-9a21-8c7d2e1f0a11", "eventName": "Maratón Ciudad Demo 2027", "status": "PAID", "amountCents": 800, "currency": "USD", "paymentGateway": "STRIPE", "buyerEmail": "corredor@example.com", "itemCount": 1, "paidAt": "2027-03-14T10:02:11.000Z", "refundedAt": None, "disputedAt": "2027-03-20T12:00:00.000Z", "disputeOutcome": "won", "settlementStatus": "PENDING", "settledAt": None, "createdAt": "2027-03-14T10:01:40.000Z"},
    'usage.threshold': {'metric': 'photos', 'threshold': 80, 'used': 80000, 'limit': 100000, 'period': '2026-10-28'},
}
