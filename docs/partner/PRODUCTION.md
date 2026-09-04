# Checklist de producción para clientes

## Credenciales

- Una clave por sistema y ambiente.
- Solo los scopes estrictamente necesarios.
- Secretos fuera del código, navegador, app móvil y logs.
- Rotación y revocación ensayadas con responsable asignado.
- Nunca compartir una clave entre empresas o workspaces.

## Cliente HTTP

- Timeouts de conexión y respuesta explícitos.
- Reintentos acotados solo ante fallos de red, `409` en curso, `429` y `5xx`.
- Backoff exponencial con jitter y respeto de `Retry-After`.
- Misma `Idempotency-Key` para cada reintento de una operación lógica.
- Validación de códigos HTTP y del esquema de respuesta.
- Tolerancia a campos JSON adicionales.
- Logs sin claves, selfies, cuerpos sensibles ni URLs temporales.

## Upload

- SHA-256 calculado sobre los bytes exactos enviados.
- `Content-Type` del PUT idéntico al solicitado.
- `clientFileId` estable y único dentro del lote.
- Confirmación solo después de un PUT exitoso.
- Reconciliación contra el estado final del lote.
- Duplicados idempotentes tratados como éxito.
- Manejo de archivos corruptos, demasiado grandes y tipos no admitidos.

## Imágenes y descargas

- `watermarkThumbnail` en cuadrículas y resultados públicos.
- `watermark` en preview ampliado.
- `thumbnail` limpio solo en sistemas internos autorizados.
- Original solicitado únicamente desde backend con `photos:download`.
- Autorización de pedido completada antes de `/download-url`.
- `/download-free` usado cuando apliquen reglas de galería y sponsors.
- URL temporal entregada inmediatamente y nunca persistida como URL del activo.
- `ready:false` tratado como pendiente; esperar webhook o consultar lote.

## Webhooks

- Endpoint HTTPS público sin redirecciones.
- HMAC verificado sobre el body crudo.
- Ventana de timestamp máxima de cinco minutos.
- Deduplicación persistente por event ID.
- Respuesta `2xx` rápida y procesamiento posterior asíncrono.
- Alertas sobre entregas fallidas.
- Reconciliación periódica de lotes aunque existan webhooks.
- Rotación del secreto probada.

## Privacidad y datos biométricos

El cliente debe contar con base legal, avisos y consentimientos aplicables antes
de enviar selfies o imágenes a búsqueda facial. También debe definir retención,
eliminación, acceso restringido y atención de derechos. No debe conservar la
selfie más tiempo del necesario ni incluirla en telemetría.

## Pruebas obligatorias antes del go-live

1. Integrar primero en un workspace no productivo.
2. Probar archivo válido, corrupto, repetido, límite de tamaño y tipo inválido.
3. Probar IDs inexistentes y ajenos; deben responder `404` sin revelar datos.
4. Simular timeout y verificar que la idempotencia evita duplicados.
5. Probar `401`, scope faltante, límite `429` y recuperación ante `5xx`.
6. Probar firma inválida, timestamp vencido, replay y webhook duplicado.
7. Rotar API key y secreto webhook sin interrupción prolongada.
8. Probar descarga original y, si aplica, gratuita limpia y patrocinada.
9. Validar exportaciones con caracteres especiales y campos vacíos.
10. Ejecutar la prueba de capacidad acordada y confirmar alertas.

## Operación

- Métricas por endpoint, latencia, código HTTP y reintentos, sin datos sensibles.
- Alertas por errores sostenidos, lotes fallidos y webhooks fallidos.
- Responsable y canal de incidentes definidos.
- Procedimiento para revocar credenciales expuestas.
- Procedimiento para reconciliar eventos, lotes y entregas.
- Versión de OpenAPI fijada en generación de clientes y revisión controlada de cambios.

Cumplir esta lista valida la integración del cliente; los compromisos de
disponibilidad, soporte y capacidad son los definidos en su contrato comercial.
