# LucilaMon Infrastructure API

Documentación pública para integraciones empresariales servidor a servidor.

## Alcance

La API permite administrar el ciclo completo de un evento fotográfico: eventos,
galerías, carga y procesamiento de imágenes, búsquedas por dorsal o rostro,
revisión, descargas, patrocinadores, métricas, exportaciones, marca blanca y
webhooks.

El cliente puede conservar su propio checkout, pagos, pedidos, impuestos y
relación con el comprador. En ese modelo, LucilaMon procesa y entrega imágenes;
la autorización comercial de cada descarga corresponde al cliente.

Esta documentación describe exclusivamente el contrato público. Los nombres de
proveedores, componentes internos, almacenamiento, colas, modelos y decisiones
de infraestructura no forman parte del contrato y pueden cambiar sin afectar la
integración.

## Documentos

1. [Inicio rápido](QUICKSTART.md): primera integración de extremo a extremo.
2. [Referencia funcional](REFERENCE.md): endpoints, scopes, estados, límites y errores.
3. [Webhooks](WEBHOOKS.md): eventos, firma, reintentos y operación.
4. [Salida a producción](PRODUCTION.md): checklist técnico y de seguridad.
5. [Contrato OpenAPI](../partner-openapi.yaml): especificación legible por herramientas y generadores de SDK.

## Convenciones

- Base URL: `https://api.lucilamon.com/v1/partner`
- Autenticación recomendada: `Authorization: Bearer <api-key>`
- Alternativa compatible: `X-API-Key: <api-key>`
- JSON en solicitudes y respuestas, salvo uploads `multipart/form-data` y el
  `PUT` de bytes a una URL de carga temporal.
- Fechas: ISO 8601 en UTC.
- Identificadores: UUID.
- Claves y secretos se muestran una sola vez al crearse o rotarse.

```json
{
  "data": {},
  "meta": {}
}
```

Los listados devuelven elementos en `data`; la paginación, cursores y estadísticas
aparecen en `meta`. Las respuestas de error usan un código estable para lógica de
cliente y un mensaje para diagnóstico.

## Compatibilidad

La versión mayor está incluida en la URL. Dentro de `v1` pueden agregarse campos
opcionales, valores de metadatos y nuevos eventos. El cliente debe ignorar campos
desconocidos y no depender del orden de propiedades JSON.

## Soporte

Al reportar una incidencia incluye método, ruta, hora UTC, código HTTP, prefijo de
la API key y el identificador recibido. Nunca envíes la clave completa, secretos
webhook, selfies ni URLs temporales de descarga.
