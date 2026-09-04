# Webhooks

Los webhooks notifican cambios asíncronos sin consultar repetidamente la API.
Una suscripción define una URL HTTPS y uno o más tipos de evento.

## Crear una suscripción

Desde **Dashboard → API e integraciones → Webhooks** o mediante:

```http
POST /v1/partner/webhooks
Authorization: Bearer <api-key con webhooks:manage>
Content-Type: application/json

{"url":"https://api.empresa.com/webhooks/lucilamon","events":["photo.processing.completed","photo.processing.failed"]}
```

La respuesta incluye `signingSecret` una sola vez. Almacénalo como secreto. La
URL debe ser HTTPS pública, válida y sin redirecciones.

## Formato

```json
{
  "id":"uuid-estable-de-la-entrega-lógica",
  "type":"photo.processing.completed",
  "createdAt":"2026-09-03T12:00:00.000Z",
  "data":{"eventId":"uuid","photoId":"uuid","status":"PROCESSED"}
}
```

Headers:

```text
x-lucilamon-event-id: <uuid>
x-lucilamon-timestamp: <unix-seconds>
x-lucilamon-signature: v1=<hex-hmac-sha256>
```

La entrada firmada es `<timestamp>.<raw-body>`. Verifica el cuerpo crudo antes
de deserializarlo y rechaza timestamps con más de cinco minutos de diferencia.

## Verificación en Node.js

```js
import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyLucilaMon(rawBody, headers, secret) {
  const timestamp = String(headers["x-lucilamon-timestamp"] || "");
  const signature = String(headers["x-lucilamon-signature"] || "");
  const received = signature.replace(/^v1=/, "");
  if (!/^\d+$/.test(timestamp)) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  if (!/^[a-f0-9]{64}$/i.test(received)) return false;

  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");
  const a = Buffer.from(received, "hex");
  const b = Buffer.from(expected, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
```

## Verificación en Python

```python
import hashlib
import hmac
import time

def verify(raw_body: bytes, timestamp: str, signature: str, secret: str) -> bool:
    if not timestamp.isdigit() or abs(time.time() - int(timestamp)) > 300:
        return False
    received = signature.removeprefix("v1=")
    expected = hmac.new(
        secret.encode(), timestamp.encode() + b"." + raw_body, hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(expected, received)
```

## Semántica de entrega

- Entrega al menos una vez: un evento puede llegar repetido.
- Deduplica de forma persistente por `x-lucilamon-event-id`.
- Responde cualquier `2xx` en menos de 10 segundos.
- Ejecuta el trabajo posterior de forma asíncrona.
- No se siguen redirecciones.
- Los fallos se reintentan hasta ocho veces con espera creciente.
- Una entrega fallida puede reintentarse manualmente desde dashboard o API.
- El orden entre tipos de evento no está garantizado; consulta el recurso actual
  si necesitas reconciliar estado.

## Catálogo completo

| Evento | Se emite cuando |
|---|---|
| `event.created` | El evento fue creado |
| `event.updated` | Se guardaron cambios del evento |
| `event.deleted` | El evento fue archivado y despublicado |
| `event.restored` | El evento fue restaurado |
| `event.cover.updated` | Se agregó o sustituyó la portada |
| `event.cover.removed` | Se eliminó la portada |
| `event.gallery.updated` | Cambió la configuración de galería |
| `event.contributor.invited` | Se creó una invitación |
| `event.contributor.revoked` | Se revocó un colaborador |
| `event.sponsor.attached` | Se vinculó un sponsor al evento |
| `event.sponsor.detached` | Se desvinculó un sponsor |
| `upload.batch.created` | Se creó un lote |
| `upload.batch.completed` | Todos sus archivos terminaron sin fallo terminal |
| `upload.batch.failed` | El lote terminó con uno o más fallos |
| `photo.processing.completed` | La foto y sus derivados quedaron disponibles |
| `photo.processing.failed` | El procesamiento terminó con error |
| `photo.deleted` | La fotografía fue eliminada |
| `photo.reviewed` | Cambió su estado de revisión/publicación |
| `photo.download_url.created` | Se autorizó una URL temporal del original |
| `photo.free_downloaded` | Se completó una descarga gratuita o patrocinada |
| `photo.bulk.completed` | Terminó una operación masiva |
| `workspace.brand.updated` | Cambió la configuración o activo de marca |

## Gestión y rotación

- `PATCH /webhooks/{endpointId}` cambia URL, eventos o `active`.
- `POST /webhooks/{endpointId}/rotate-secret` invalida el secreto anterior para
  nuevas entregas y devuelve el nuevo una sola vez.
- `GET /webhooks/{endpointId}/deliveries` devuelve las últimas 100 entregas.
- `POST /webhooks/deliveries/{deliveryId}/retry` reprograma una fallida.

Durante una rotación coordinada, actualiza el secreto consumidor inmediatamente.
No registres headers de firma junto al body si este contiene datos personales.

Los objetos `data` pueden recibir campos opcionales compatibles. Ignora campos
desconocidos y usa `type` como discriminador.
