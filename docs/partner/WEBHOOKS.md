# Webhooks

## Suscripción

Se administran desde **Dashboard → API e integraciones → Webhooks** o mediante:

```http
POST /v1/partner/webhooks
Authorization: Bearer <api-key con webhooks:manage>
Content-Type: application/json

{"url":"https://api.empresa.com/webhooks/lucilamon","events":["photo.processing.completed","photo.processing.failed"]}
```

`signingSecret` aparece una sola vez. Rotarlo invalida la firma anterior para
nuevas entregas.

## Sobre recibido

```json
{
  "id": "uuid-estable",
  "type": "photo.processing.completed",
  "createdAt": "2026-09-03T12:00:00.000Z",
  "data": {"photoId":"...","eventId":"...","status":"PROCESSED"}
}
```

Headers:

```text
x-lucilamon-event-id: <uuid>
x-lucilamon-timestamp: <unix-seconds>
x-lucilamon-signature: v1=<hex>
```

## Verificación Node.js

```js
import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyLucilaMon(rawBody, headers, secret) {
  const timestamp = String(headers["x-lucilamon-timestamp"] || "");
  const received = String(headers["x-lucilamon-signature"] || "").replace(/^v1=/, "");
  if (!/^\d+$/.test(timestamp) || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  const a = Buffer.from(received, "hex");
  const b = Buffer.from(expected, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
```

Captura el body crudo antes de `JSON.parse`. Responde `2xx` rápidamente y mueve
el trabajo pesado a tu propia cola.

## Verificación Python

```python
import hashlib, hmac, time

def verify(raw_body: bytes, timestamp: str, signature: str, secret: str) -> bool:
    if abs(time.time() - int(timestamp)) > 300:
        return False
    expected = hmac.new(secret.encode(), timestamp.encode() + b"." + raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature.removeprefix("v1="))
```

## Entrega

- Semántica **at least once**: pueden existir duplicados.
- Deduplicar por `x-lucilamon-event-id` con índice único.
- Timeout: 10 segundos.
- Éxito: cualquier `2xx`.
- No se siguen redirecciones.
- Ocho intentos con backoff exponencial.
- Una entrega trabada en `PROCESSING` se recupera automáticamente.
- Las fallidas pueden reintentarse desde el dashboard.

## Eventos

| Evento | Momento |
|---|---|
| `event.created` | Evento persistido |
| `event.updated` | Cambio persistido |
| `event.deleted` | Eliminación aceptada |
| `upload.batch.created` | Lote persistido |
| `upload.batch.completed` | Todos sus elementos terminaron sin fallo terminal |
| `upload.batch.failed` | Lote terminó con uno o más fallos |
| `photo.processing.completed` | Derivados/OCR base terminaron y la foto está disponible |
| `photo.processing.failed` | Se agotaron los intentos principales |
| `photo.deleted` | Registro eliminado |
| `photo.download_url.created` | Una integración autorizó una descarga |

El consumidor no debe depender de campos desconocidos: podrán agregarse campos
compatibles al objeto `data` sin cambiar la versión mayor.
