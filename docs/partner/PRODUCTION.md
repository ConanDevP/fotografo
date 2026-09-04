# Checklist de producción para clientes

## Credenciales

- Una clave por sistema y ambiente.
- Solo scopes necesarios.
- Secretos en Vault/KMS/Secrets Manager.
- Rotación ensayada y responsable asignado.
- Revocación inmediata ante exposición.
- Nunca compartir una clave entre empresas o workspaces.

## Integración HTTP

- Timeout de conexión y respuesta configurado.
- Reintentos solo en `429`, `5xx` y fallos de red.
- Backoff exponencial con jitter.
- Misma `Idempotency-Key` en cada reintento lógico.
- Validación del esquema de respuesta.
- Logs sin API keys, selfies ni URLs firmadas.

## Upload

- SHA-256 calculado sobre los bytes enviados.
- `Content-Type` del PUT idéntico al firmado.
- `clientFileId` estable y único dentro del lote.
- Confirmar únicamente después de un PUT exitoso.
- Reconciliar contra el estado final del lote.
- Manejar duplicados como éxito idempotente.

## Entrega de imágenes

- Mostrar `watermarkThumbnail` en cuadrículas y resultados.
- Mostrar `watermark` en la vista previa ampliada.
- No utilizar `thumbnail` limpio en una galería pública.
- Solicitar el original solo desde un backend con `photos:download`.
- Entregar la URL firmada inmediatamente; nunca persistirla como URL del activo.
- No registrar URLs firmadas porque contienen autorización temporal.
- Tratar `ready: false` como procesamiento pendiente y esperar webhook o consultar el lote.

## Webhooks

- HTTPS público sin redirecciones.
- Verificar HMAC sobre el body crudo.
- Ventana máxima de timestamp: cinco minutos.
- Deduplicación persistente por event ID.
- Respuesta `2xx` antes de trabajo pesado.
- Alertas sobre entregas `FAILED`.
- Procedimiento documentado para rotar `whsec_`.

## Privacidad biométrica

El cliente debe contar con base legal, avisos y consentimiento aplicables para
enviar selfies o fotografías a reconocimiento facial. Debe definir retención,
eliminación y atención de derechos. LucilaMon procesa los datos técnicos; no
autoriza por sí mismo su recopilación ni venta.

## Go-live

1. Integrar primero en un workspace no productivo.
2. Probar archivos válidos, corruptos, repetidos y máximos.
3. Probar aislamiento con IDs ajenos: debe responder `404`.
4. Simular timeout y comprobar idempotencia.
5. Probar firma inválida, replay y duplicado de webhook.
6. Rotar API key y secreto webhook en ensayo.
7. Confirmar alertas, responsable y canal de incidentes.
8. Ejecutar prueba de capacidad acordada.
