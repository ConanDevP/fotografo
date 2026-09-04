# Inicio rápido

## 1. Crear una credencial

En **Dashboard → API e integraciones**, crea una credencial con:

```text
events:read events:write photos:read photos:upload search:bib search:face photos:download webhooks:manage
```

Guárdala inmediatamente como `LUCILAMON_API_KEY`.

## 2. Crear un evento

```bash
curl -X POST "https://api.lucilamon.com/v1/partner/events" \
  -H "Authorization: Bearer $LUCILAMON_API_KEY" \
  -H "Idempotency-Key: event-media-maraton-2026" \
  -H "Content-Type: application/json" \
  -d '{"name":"Media Maratón 2026","date":"2026-11-08T12:00:00.000Z","location":"Ciudad de Guatemala","requiresPhotoApproval":false}'
```

Conserva `data.id` como `eventId`. Repetir la misma petición con la misma
`Idempotency-Key` durante 24 horas devuelve el resultado original.

## 3. Crear un lote

```bash
curl -X POST "https://api.lucilamon.com/v1/partner/events/$EVENT_ID/upload-batches" \
  -H "Authorization: Bearer $LUCILAMON_API_KEY" \
  -H "Idempotency-Key: batch-camera-a-001" \
  -H "Content-Type: application/json" \
  -d '{"totalFiles":1}'
```

## 4. Firmar y subir

Calcula SHA-256 sobre los bytes exactos y solicita una URL:

```bash
SHA256=$(sha256sum IMG_001.jpg | cut -d' ' -f1)
curl -X POST "https://api.lucilamon.com/v1/partner/upload-batches/$BATCH_ID/files" \
  -H "Authorization: Bearer $LUCILAMON_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"files\":[{\"clientFileId\":\"camera-a-IMG_001\",\"fileName\":\"IMG_001.jpg\",\"contentType\":\"image/jpeg\",\"sizeBytes\":$(wc -c < IMG_001.jpg),\"contentHash\":\"$SHA256\"}]}"
```

Haz `PUT` a `uploadUrl` con el mismo `Content-Type`. Después confirma:

```bash
curl -X POST "https://api.lucilamon.com/v1/partner/upload-batches/$BATCH_ID/complete" \
  -H "Authorization: Bearer $LUCILAMON_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"clientFileIds":["camera-a-IMG_001"]}'
```

Se permiten 50 archivos por solicitud de firma/confirmación y hasta 5,000 por
lote. `clientFileId` debe ser estable: es la identidad idempotente del archivo.

## 5. Esperar procesamiento

Consulta el lote o suscríbete a `upload.batch.completed` y
`photo.processing.completed`:

```bash
curl "https://api.lucilamon.com/v1/partner/upload-batches/$BATCH_ID" \
  -H "Authorization: Bearer $LUCILAMON_API_KEY"
```

Estados terminales: `COMPLETED` y `FAILED`.

## 6. Buscar y descargar

```bash
curl "https://api.lucilamon.com/v1/partner/events/$EVENT_ID/search/bib?bib=314" \
  -H "Authorization: Bearer $LUCILAMON_API_KEY"

curl "https://api.lucilamon.com/v1/partner/photos/$PHOTO_ID/assets" \
  -H "Authorization: Bearer $LUCILAMON_API_KEY"

curl -X POST "https://api.lucilamon.com/v1/partner/photos/$PHOTO_ID/download-url" \
  -H "Authorization: Bearer $LUCILAMON_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"expiresIn":300}'
```

La empresa decide si el usuario puede descargar. LucilaMon no valida su pago.
La URL expira en 60–900 segundos y no debe almacenarse como URL permanente.

Para galerías muestra `assets.watermarkThumbnail`; para una vista grande usa
`assets.watermark`. El detalle y `/assets` nunca incluyen la URL del original.
