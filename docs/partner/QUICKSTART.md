# Inicio rápido

Este recorrido crea un evento, carga una foto, espera su procesamiento, busca el
resultado y obtiene una descarga. Todos los comandos deben ejecutarse desde un
backend seguro.

## 1. Crear una credencial

En **Dashboard → API e integraciones**, crea una credencial con los scopes mínimos:

```text
events:read events:write photos:read photos:upload search:bib photos:download webhooks:manage
```

Guarda el valor una sola vez en tu gestor de secretos como
`LUCILAMON_API_KEY`. Usa una credencial distinta por ambiente.

## 2. Crear un evento

```bash
curl -X POST "https://api.lucilamon.com/v1/partner/events" \
  -H "Authorization: Bearer $LUCILAMON_API_KEY" \
  -H "Idempotency-Key: event-media-maraton-2026" \
  -H "Content-Type: application/json" \
  -d '{"name":"Media Maratón 2026","date":"2026-11-08T12:00:00.000Z","location":"Ciudad de Guatemala","requiresPhotoApproval":false}'
```

Conserva `data.id` como `EVENT_ID`. La misma solicitud con la misma clave de
idempotencia reproduce el resultado original durante 24 horas.

## 3. Crear un lote

```bash
curl -X POST "https://api.lucilamon.com/v1/partner/events/$EVENT_ID/upload-batches" \
  -H "Authorization: Bearer $LUCILAMON_API_KEY" \
  -H "Idempotency-Key: batch-camera-a-001" \
  -H "Content-Type: application/json" \
  -d '{"totalFiles":1}'
```

Conserva `data.id` como `BATCH_ID`.

## 4. Solicitar carga, subir y confirmar

Calcula SHA-256 sobre los bytes exactos. Solicita la URL temporal:

```bash
curl -X POST "https://api.lucilamon.com/v1/partner/upload-batches/$BATCH_ID/files" \
  -H "Authorization: Bearer $LUCILAMON_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"files":[{"clientFileId":"camera-a-IMG_001","fileName":"IMG_001.jpg","contentType":"image/jpeg","sizeBytes":1234567,"contentHash":"<sha256-hex>"}]}'
```

Haz `PUT` de los bytes a `data[].uploadUrl` con el mismo `Content-Type` firmado.
No agregues el header de API de LucilaMon a ese `PUT`. Luego confirma:

```bash
curl -X POST "https://api.lucilamon.com/v1/partner/upload-batches/$BATCH_ID/complete" \
  -H "Authorization: Bearer $LUCILAMON_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"clientFileIds":["camera-a-IMG_001"]}'
```

Se admiten 50 archivos por solicitud y hasta 5,000 por lote. `clientFileId` debe
ser estable en reintentos.

## 5. Esperar el resultado

Usa webhooks como mecanismo principal y consulta el lote para reconciliación:

```bash
curl "https://api.lucilamon.com/v1/partner/upload-batches/$BATCH_ID" \
  -H "Authorization: Bearer $LUCILAMON_API_KEY"
```

Escucha `photo.processing.completed`, `photo.processing.failed`,
`upload.batch.completed` y `upload.batch.failed`.

## 6. Buscar y mostrar previews

```bash
curl "https://api.lucilamon.com/v1/partner/events/$EVENT_ID/search/bib?bib=314" \
  -H "Authorization: Bearer $LUCILAMON_API_KEY"

curl "https://api.lucilamon.com/v1/partner/photos/$PHOTO_ID/assets" \
  -H "Authorization: Bearer $LUCILAMON_API_KEY"
```

Usa `watermarkThumbnail` en cuadrículas y `watermark` en vista ampliada. El
original nunca se incluye en el detalle ni en `/assets`.

## 7. Elegir el flujo de descarga

Si tu empresa cobra y autoriza por su cuenta, solicita el original después de
validar el pedido en tu backend:

```bash
curl -X POST "https://api.lucilamon.com/v1/partner/photos/$PHOTO_ID/download-url" \
  -H "Authorization: Bearer $LUCILAMON_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"expiresIn":300}'
```

Si utilizas la galería gratuita de LucilaMon, usa el flujo que aplica límites,
captura de audiencia y patrocinadores:

```bash
curl -X POST "https://api.lucilamon.com/v1/partner/events/$EVENT_ID/photos/$PHOTO_ID/download-free" \
  -H "Authorization: Bearer $LUCILAMON_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"email":"corredor@ejemplo.com","name":"Ana","bibNumber":"314"}'
```

No uses `/download-url` para eludir las reglas de una galería gratuita. Las URLs
expiran entre 60 y 900 segundos y nunca deben guardarse como URL permanente.

## 8. Activar webhooks

```bash
curl -X POST "https://api.lucilamon.com/v1/partner/webhooks" \
  -H "Authorization: Bearer $LUCILAMON_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://api.empresa.com/webhooks/lucilamon","events":["photo.processing.completed","photo.processing.failed"]}'
```

Guarda `data.signingSecret`: solo se muestra en esta respuesta.
