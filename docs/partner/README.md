# LucilaMon Infrastructure API

Documentación para integraciones empresariales servidor-a-servidor.

## Qué resuelve

LucilaMon recibe fotografías, genera derivados, detecta dorsales y rostros,
permite búsquedas y entrega originales mediante URLs privadas temporales. El
cliente conserva su checkout, pagos, pedidos, impuestos y relación con el
comprador final.

Las galerías empresariales reciben miniaturas y vistas previas con marca de
agua. Los originales están separados por scope y solo se entregan con URLs
firmadas de corta duración.

## Documentos

1. [Inicio rápido](QUICKSTART.md)
2. [Referencia y operación](REFERENCE.md)
3. [Webhooks y verificación](WEBHOOKS.md)
4. [Seguridad y salida a producción](PRODUCTION.md)
5. [Contrato OpenAPI](../partner-openapi.yaml)

## Base URL

```text
https://api.lucilamon.com/v1/partner
```

Todas las llamadas usan JSON salvo el `PUT` directo al almacenamiento firmado.
Las fechas están en ISO 8601 UTC y los identificadores son UUID.

## Autenticación

```http
Authorization: Bearer lm_live_<prefijo>_<secreto>
```

La clave se muestra únicamente al crearla o rotarla. Debe permanecer en el
backend o gestor de secretos del cliente; nunca en navegador, app móvil, logs o
repositorio. `X-API-Key` también funciona, pero Bearer es el formato recomendado.

## Modelo de respuesta

```json
{
  "data": {},
  "meta": {}
}
```

Los listados colocan sus elementos en `data` y paginación o cursor en `meta`.

## Soporte

Para una incidencia, proporcionar el endpoint, hora UTC, código HTTP,
`x-lucilamon-event-id` si se trata de un webhook y prefijo de la API key. Nunca
enviar el secreto completo, una selfie ni una URL firmada por correo o chat.
