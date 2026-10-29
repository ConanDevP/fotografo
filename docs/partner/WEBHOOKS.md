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
- Los fallos se reintentan hasta ocho veces con espera creciente (2, 4, 8… minutos, hasta un máximo de 6 horas).
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
| `analytics.report.ready` | El informe posterior al evento está listo (`data.reportUrl`) |
| `usage.threshold` | El consumo del contrato cruzó el 80 % o el 100 % de un tope (`data.metric`: `photos`, `apiRequests` o `faceSearches`) |

## Carga de cada evento

Ejemplo del objeto `data` de cada uno de los 28 eventos (los de eventos y fotografías con datos reales de una API de prueba;
los que emite un proceso en segundo plano, escritos a partir del código que los emite).

<!-- payloads:start -->

### `event.created`

Se creó un evento.

```json
{
  "id": "700aa54a-6220-5d79-a9b4-a63a63ec7be9",
  "type": "event.created",
  "createdAt": "2026-10-29T08:33:06.193Z",
  "data": {
    "id": "ea74bc9e-2c05-5784-b7d0-c4dc36d9bf96",
    "date": "2027-03-14T00:00:00.000Z",
    "name": "Maraton Ciudad Demo 2027",
    "slug": "maraton-ciudad-demo-2027-1793262786180",
    "owner": {
      "id": "535c0e5c-a75f-56c5-83d0-d30627bc5f8c",
      "role": "PHOTOGRAPHER",
      "email": "ops@cronos.example"
    },
    "_count": {
      "photos": 0
    },
    "ownerId": "535c0e5c-a75f-56c5-83d0-d30627bc5f8c",
    "pricing": {
      "pack5": 3000,
      "pack10": 5000,
      "currency": "USD",
      "singlePhoto": 800
    },
    "bibRules": {
      "maxLen": 5,
      "minLen": 3
    },
    "imageUrl": null,
    "location": "Monterrey, Mexico",
    "createdAt": "2026-10-29T08:33:06.181Z",
    "deletedAt": null,
    "isPublished": false,
    "publishedAt": null,
    "workspaceId": "eb820b56-097f-518a-a1c0-2a75f6a9434f",
    "commerceMode": "PAID",
    "isFreeDownload": false,
    "freeDownloadLimit": null,
    "freeDownloadUntil": null,
    "totalFreeDownloads": 0,
    "requireEmailForFree": true,
    "requiresPhotoApproval": true,
    "sponsorOverlayEnabled": false,
    "organizerCommissionPercent": "0"
  }
}
```

### `event.updated`

Se actualizó un evento (datos, precio, publicación).

```json
{
  "id": "5d1269a4-070e-5113-8a6f-a9917894b7ec",
  "type": "event.updated",
  "createdAt": "2026-10-29T08:33:06.337Z",
  "data": {
    "id": "ea74bc9e-2c05-5784-b7d0-c4dc36d9bf96",
    "date": "2027-03-14T00:00:00.000Z",
    "name": "Maraton Ciudad Demo 2027",
    "slug": "maraton-ciudad-demo-2027-1793262786180",
    "owner": {
      "id": "535c0e5c-a75f-56c5-83d0-d30627bc5f8c",
      "role": "PHOTOGRAPHER",
      "email": "ops@cronos.example"
    },
    "_count": {
      "photos": 0
    },
    "ownerId": "535c0e5c-a75f-56c5-83d0-d30627bc5f8c",
    "pricing": {
      "pack5": 3000,
      "pack10": 5000,
      "currency": "USD",
      "singlePhoto": 800
    },
    "bibRules": {
      "maxLen": 5,
      "minLen": 3
    },
    "imageUrl": null,
    "location": "Parque Fundidora, Monterrey",
    "createdAt": "2026-10-29T08:33:06.181Z",
    "deletedAt": null,
    "isPublished": false,
    "publishedAt": null,
    "workspaceId": "eb820b56-097f-518a-a1c0-2a75f6a9434f",
    "commerceMode": "PAID",
    "isFreeDownload": false,
    "freeDownloadLimit": null,
    "freeDownloadUntil": null,
    "totalFreeDownloads": 0,
    "requireEmailForFree": true,
    "requiresPhotoApproval": false,
    "sponsorOverlayEnabled": false,
    "organizerCommissionPercent": "0"
  }
}
```

### `event.deleted`

Se archivó un evento (borrado lógico; se puede restaurar).

```json
{
  "id": "a1deb1c3-5582-51ee-b0f5-1307cf349e51",
  "type": "event.deleted",
  "createdAt": "2026-10-29T08:33:08.530Z",
  "data": {
    "eventId": "ea74bc9e-2c05-5784-b7d0-c4dc36d9bf96"
  }
}
```

### `event.restored`

Se restauró un evento archivado.

```json
{
  "id": "b5f0a68f-cdba-5efa-b737-ba26330d4c43",
  "type": "event.restored",
  "createdAt": "2026-10-29T08:33:08.550Z",
  "data": {
    "eventId": "ea74bc9e-2c05-5784-b7d0-c4dc36d9bf96"
  }
}
```

### `event.cover.updated`

Se subió o reemplazó la portada del evento.

```json
{
  "id": "0b6f6a5e-7a8c-4f4e-9b1d-2a3c4e5f6a7b",
  "type": "event.cover.updated",
  "createdAt": "2027-03-14T09:12:44.318Z",
  "data": {
    "eventId": "5b0c1e7e-4d3a-4f6e-9a21-8c7d2e1f0a11",
    "imageUrl": "https://cdn.example.com/events/5b0c1e7e/cover.jpg"
  }
}
```

### `event.cover.removed`

Se quitó la portada del evento.

```json
{
  "id": "0b6f6a5e-7a8c-4f4e-9b1d-2a3c4e5f6a7b",
  "type": "event.cover.removed",
  "createdAt": "2027-03-14T09:12:44.318Z",
  "data": {
    "eventId": "5b0c1e7e-4d3a-4f6e-9a21-8c7d2e1f0a11"
  }
}
```

### `event.gallery.updated`

Cambió la configuración de galería: publicación, descargas gratuitas, patrocinadores.

```json
{
  "id": "d39ba6e2-83f9-5c81-b78e-232a9a27bd0c",
  "type": "event.gallery.updated",
  "createdAt": "2026-10-29T08:33:06.387Z",
  "data": {
    "config": {
      "isFreeDownload": true,
      "freeDownloadLimit": 500,
      "requireEmailForFree": true,
      "sponsorOverlayEnabled": false
    },
    "eventId": "ea74bc9e-2c05-5784-b7d0-c4dc36d9bf96"
  }
}
```

### `event.contributor.invited`

Se invitó a un fotógrafo al evento.

```json
{
  "id": "d163e8ee-7299-56e1-980e-34f59cea5c42",
  "type": "event.contributor.invited",
  "createdAt": "2026-10-29T08:33:07.974Z",
  "data": {
    "eventId": "ea74bc9e-2c05-5784-b7d0-c4dc36d9bf96",
    "contributor": {
      "id": "e5b93ff6-a37a-5b98-a092-73ffd841dc22",
      "role": "PHOTOGRAPHER",
      "status": "INVITED",
      "userId": null,
      "eventId": "ea74bc9e-2c05-5784-b7d0-c4dc36d9bf96",
      "createdAt": "2026-10-29T08:33:07.965Z",
      "expiresAt": "2026-11-12T08:33:07.964Z",
      "revokedAt": null,
      "updatedAt": "2026-10-29T08:33:07.965Z",
      "acceptedAt": null,
      "declinedAt": null,
      "invitedById": "535c0e5c-a75f-56c5-83d0-d30627bc5f8c",
      "rightsTerms": "El fotografo conserva la autoria; el organizador recibe 30% de cada venta.",
      "invitedEmail": "fotografo@example.com",
      "lastInvitedAt": "2026-10-29T08:33:07.964Z",
      "rightsAcceptedAt": null,
      "photographerWorkspaceId": null,
      "organizerCommissionPercent": "30"
    }
  }
}
```

### `event.contributor.revoked`

Se revocó la invitación o el acceso de un fotógrafo.

```json
{
  "id": "9a3ebb4d-cf40-55ec-8a84-dc3d5118e2d5",
  "type": "event.contributor.revoked",
  "createdAt": "2026-10-29T08:33:08.023Z",
  "data": {
    "eventId": "ea74bc9e-2c05-5784-b7d0-c4dc36d9bf96",
    "contributorId": "e5b93ff6-a37a-5b98-a092-73ffd841dc22"
  }
}
```

### `event.sponsor.attached`

Se asignó un patrocinador al evento.

```json
{
  "id": "ccdf38b0-ede5-56cb-8bc0-ad2bb35c9422",
  "type": "event.sponsor.attached",
  "createdAt": "2026-10-29T08:33:07.868Z",
  "data": {
    "eventId": "ea74bc9e-2c05-5784-b7d0-c4dc36d9bf96",
    "sponsorId": "40442068-9a1b-52cc-9b33-44c74c7f96f2"
  }
}
```

### `event.sponsor.detached`

Se quitó un patrocinador del evento.

```json
{
  "id": "74473331-28e4-51eb-af7a-1aa467678994",
  "type": "event.sponsor.detached",
  "createdAt": "2026-10-29T08:33:07.923Z",
  "data": {
    "eventId": "ea74bc9e-2c05-5784-b7d0-c4dc36d9bf96",
    "sponsorId": "40442068-9a1b-52cc-9b33-44c74c7f96f2"
  }
}
```

### `upload.batch.created`

Se creó un lote de carga.

```json
{
  "id": "983a9713-fd9d-562c-94f0-b136053dd6dc",
  "type": "upload.batch.created",
  "createdAt": "2026-10-29T08:33:07.410Z",
  "data": {
    "id": "7fe2a7bc-9638-5c50-9190-10ce669af2fc",
    "status": "PENDING",
    "eventId": "ea74bc9e-2c05-5784-b7d0-c4dc36d9bf96",
    "createdAt": "2026-10-29T08:33:07.405Z",
    "totalFiles": 2
  }
}
```

### `upload.batch.completed`

El lote terminó de procesarse.

```json
{
  "id": "0b6f6a5e-7a8c-4f4e-9b1d-2a3c4e5f6a7b",
  "type": "upload.batch.completed",
  "createdAt": "2027-03-14T09:12:44.318Z",
  "data": {
    "batchId": "2a6e0f55-1c0d-4b77-8f42-3d1b9c7a5e10",
    "eventId": "5b0c1e7e-4d3a-4f6e-9a21-8c7d2e1f0a11",
    "status": "COMPLETED",
    "totalFiles": 480,
    "processedFiles": 480,
    "failedItems": 0
  }
}
```

### `upload.batch.failed`

El lote terminó con errores que impiden completarlo.

```json
{
  "id": "0b6f6a5e-7a8c-4f4e-9b1d-2a3c4e5f6a7b",
  "type": "upload.batch.failed",
  "createdAt": "2027-03-14T09:12:44.318Z",
  "data": {
    "batchId": "2a6e0f55-1c0d-4b77-8f42-3d1b9c7a5e10",
    "eventId": "5b0c1e7e-4d3a-4f6e-9a21-8c7d2e1f0a11",
    "status": "FAILED",
    "totalFiles": 480,
    "processedFiles": 441,
    "failedItems": 39
  }
}
```

### `photo.processing.completed`

Una fotografía terminó de procesarse: ya tiene miniatura, marca de agua y dorsales leídos.

```json
{
  "id": "0b6f6a5e-7a8c-4f4e-9b1d-2a3c4e5f6a7b",
  "type": "photo.processing.completed",
  "createdAt": "2027-03-14T09:12:44.318Z",
  "data": {
    "photoId": "7aafef5c-b3bb-4ea0-bcfd-612bc887ba4f",
    "eventId": "5b0c1e7e-4d3a-4f6e-9a21-8c7d2e1f0a11",
    "status": "PROCESSED",
    "processingCompletedAt": "2027-03-14T09:12:44.318Z"
  }
}
```

### `photo.processing.failed`

El procesamiento de una fotografía falló tras agotar los reintentos.

```json
{
  "id": "0b6f6a5e-7a8c-4f4e-9b1d-2a3c4e5f6a7b",
  "type": "photo.processing.failed",
  "createdAt": "2027-03-14T09:12:44.318Z",
  "data": {
    "photoId": "7aafef5c-b3bb-4ea0-bcfd-612bc887ba4f",
    "eventId": "5b0c1e7e-4d3a-4f6e-9a21-8c7d2e1f0a11",
    "status": "FAILED",
    "error": "No se pudo generar la versión con marca de agua"
  }
}
```

### `photo.deleted`

Se borró una fotografía.

```json
{
  "id": "72afe52d-4a8f-5351-a92e-42d790e8060b",
  "type": "photo.deleted",
  "createdAt": "2026-10-29T08:33:08.442Z",
  "data": {
    "photoId": "4622b7a1-5bdb-509b-a0fc-76342a7ee168"
  }
}
```

### `photo.reviewed`

Se aprobó o rechazó una fotografía.

```json
{
  "id": "923870e4-e151-5612-81a7-116bdc0b0990",
  "type": "photo.reviewed",
  "createdAt": "2026-10-29T08:33:06.856Z",
  "data": {
    "status": "APPROVED",
    "eventId": "ea74bc9e-2c05-5784-b7d0-c4dc36d9bf96",
    "photoId": "8cf7ee8f-63ec-5687-a67a-5d4a96f59f2e"
  }
}
```

### `photo.download_url.created`

Se generó un enlace temporal al original.

```json
{
  "id": "ca3430b7-a1cf-5b31-b06e-160546b52cfc",
  "type": "photo.download_url.created",
  "createdAt": "2026-10-29T08:33:06.906Z",
  "data": {
    "photoId": "5b620345-8891-5e42-9b8a-05abb178d175",
    "expiresIn": 300
  }
}
```

### `photo.free_downloaded`

Alguien descargó una fotografía gratuita.

```json
{
  "id": "d72b1a98-803a-56ba-82bc-794f26ce8ba5",
  "type": "photo.free_downloaded",
  "createdAt": "2026-10-29T08:33:07.218Z",
  "data": {
    "eventId": "816f5f1a-c36a-574a-8230-52c46b845ad2",
    "photoId": "7a8ee3f6-fdd1-5125-b911-44a3a50eaffe",
    "variant": "CLEAN",
    "sponsors": []
  }
}
```

### `photo.bulk.completed`

Terminó una operación masiva sobre fotografías.

```json
{
  "id": "7e42d4e7-7a8a-51d0-a457-dfb63761abc7",
  "type": "photo.bulk.completed",
  "createdAt": "2026-10-29T08:33:07.243Z",
  "data": {
    "eventId": "ea74bc9e-2c05-5784-b7d0-c4dc36d9bf96",
    "affected": 2,
    "operation": "review",
    "requested": 2
  }
}
```

### `workspace.brand.updated`

Cambió la marca, el dominio o los datos de tu espacio.

```json
{
  "id": "6034ada1-c30c-5f2d-9c79-1ad71980cbd9",
  "type": "workspace.brand.updated",
  "createdAt": "2026-10-29T08:33:06.155Z",
  "data": {
    "workspaceId": "eb820b56-097f-518a-a1c0-2a75f6a9434f"
  }
}
```

### `analytics.report.ready`

El informe posterior al evento está listo.

```json
{
  "id": "b7810fe0-ba32-5804-8ed0-4e770c4d1ea2",
  "type": "analytics.report.ready",
  "createdAt": "2026-10-29T08:33:09.012Z",
  "data": {
    "name": "Maraton Ciudad Demo 2027",
    "eventId": "ea74bc9e-2c05-5784-b7d0-c4dc36d9bf96",
    "reportUrl": "https://app.example.com/reporte/ea74bc9e-2c05-5784-b7d0-c4dc36d9bf96?token=1.<token>",
    "computedAt": "2026-10-29T08:33:08.989Z"
  }
}
```

### `usage.threshold`

El consumo del contrato cruzó el 80 % o el 100 % de un tope.

```json
{
  "id": "0b6f6a5e-7a8c-4f4e-9b1d-2a3c4e5f6a7b",
  "type": "usage.threshold",
  "createdAt": "2027-03-14T09:12:44.318Z",
  "data": {
    "metric": "photos",
    "threshold": 80,
    "used": 80000,
    "limit": 100000,
    "period": "2026-10-28"
  }
}
```

### `order.paid`

Un pedido de tu evento se pagó en la tienda de LucilaMon. Se emite una sola vez por pedido.

```json
{
  "id": "0b6f6a5e-7a8c-4f4e-9b1d-2a3c4e5f6a7b",
  "type": "order.paid",
  "createdAt": "2027-03-14T09:12:44.318Z",
  "data": {
    "id": "a3c1e5f7-2b4d-4c6e-8a90-1b2c3d4e5f60",
    "eventId": "5b0c1e7e-4d3a-4f6e-9a21-8c7d2e1f0a11",
    "eventName": "Maratón Ciudad Demo 2027",
    "status": "PAID",
    "amountCents": 800,
    "currency": "USD",
    "paymentGateway": "STRIPE",
    "buyerEmail": "corredor@example.com",
    "itemCount": 1,
    "paidAt": "2027-03-14T10:02:11.000Z",
    "refundedAt": null,
    "disputedAt": null,
    "disputeOutcome": null,
    "settlementStatus": "PENDING",
    "settledAt": null,
    "createdAt": "2027-03-14T10:01:40.000Z"
  }
}
```

### `order.refunded`

Un pedido de tu evento se reembolsó (por ti con nuestro equipo, o por la pasarela).

```json
{
  "id": "0b6f6a5e-7a8c-4f4e-9b1d-2a3c4e5f6a7b",
  "type": "order.refunded",
  "createdAt": "2027-03-14T09:12:44.318Z",
  "data": {
    "id": "a3c1e5f7-2b4d-4c6e-8a90-1b2c3d4e5f60",
    "eventId": "5b0c1e7e-4d3a-4f6e-9a21-8c7d2e1f0a11",
    "eventName": "Maratón Ciudad Demo 2027",
    "status": "REFUNDED",
    "amountCents": 800,
    "currency": "USD",
    "paymentGateway": "STRIPE",
    "buyerEmail": "corredor@example.com",
    "itemCount": 1,
    "paidAt": "2027-03-14T10:02:11.000Z",
    "refundedAt": "2027-03-15T09:00:00.000Z",
    "disputedAt": null,
    "disputeOutcome": null,
    "settlementStatus": "NOT_REQUIRED",
    "settledAt": null,
    "createdAt": "2027-03-14T10:01:40.000Z"
  }
}
```

### `order.disputed`

El banco del comprador abrió un contracargo. Se corta el acceso a la descarga mientras dure.

```json
{
  "id": "0b6f6a5e-7a8c-4f4e-9b1d-2a3c4e5f6a7b",
  "type": "order.disputed",
  "createdAt": "2027-03-14T09:12:44.318Z",
  "data": {
    "id": "a3c1e5f7-2b4d-4c6e-8a90-1b2c3d4e5f60",
    "eventId": "5b0c1e7e-4d3a-4f6e-9a21-8c7d2e1f0a11",
    "eventName": "Maratón Ciudad Demo 2027",
    "status": "DISPUTED",
    "amountCents": 800,
    "currency": "USD",
    "paymentGateway": "STRIPE",
    "buyerEmail": "corredor@example.com",
    "itemCount": 1,
    "paidAt": "2027-03-14T10:02:11.000Z",
    "refundedAt": null,
    "disputedAt": "2027-03-20T12:00:00.000Z",
    "disputeOutcome": "needs_response",
    "settlementStatus": "PENDING",
    "settledAt": null,
    "createdAt": "2027-03-14T10:01:40.000Z"
  }
}
```

### `order.dispute.closed`

Se resolvió el contracargo: `disputeOutcome` es `won` (el pedido vuelve a `PAID`) o `lost` (queda `REFUNDED`).

```json
{
  "id": "0b6f6a5e-7a8c-4f4e-9b1d-2a3c4e5f6a7b",
  "type": "order.dispute.closed",
  "createdAt": "2027-03-14T09:12:44.318Z",
  "data": {
    "id": "a3c1e5f7-2b4d-4c6e-8a90-1b2c3d4e5f60",
    "eventId": "5b0c1e7e-4d3a-4f6e-9a21-8c7d2e1f0a11",
    "eventName": "Maratón Ciudad Demo 2027",
    "status": "PAID",
    "amountCents": 800,
    "currency": "USD",
    "paymentGateway": "STRIPE",
    "buyerEmail": "corredor@example.com",
    "itemCount": 1,
    "paidAt": "2027-03-14T10:02:11.000Z",
    "refundedAt": null,
    "disputedAt": "2027-03-20T12:00:00.000Z",
    "disputeOutcome": "won",
    "settlementStatus": "PENDING",
    "settledAt": null,
    "createdAt": "2027-03-14T10:01:40.000Z"
  }
}
```

<!-- payloads:end -->

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
