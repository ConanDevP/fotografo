# Documentación de la Partner API

La especificación pública (`docs/partner-openapi.yaml`) y las guías de referencia se **generan**. No se editan a mano.

| Qué | De dónde sale |
|---|---|
| Rutas, permisos, límites de tasa | El controlador (`partner-api.controller.ts`), leído por `extract.py` |
| Cuerpos y parámetros de entrada | Los DTOs de class-validator, leídos por `extract.py` |
| Respuestas y ejemplos | `examples.json`: respuestas **reales** de la API, saneadas por `sanitize.py` |
| Descripciones | `texts_general.py` (introducción, errores, webhooks), `texts_ops.py` (operaciones y campos), `request_fields.py` (campos de entrada) |

## Regenerar y publicar

```bash
bash scripts/partner-docs/publish.sh            # usa ../../sports-photography-platform (1) como frontend
bash scripts/partner-docs/publish.sh /ruta/al/frontend
```

Crea `docs/partner-openapi.yaml`, `docs/partner/REFERENCE.md`, las cargas de `docs/partner/WEBHOOKS.md` y, en el frontend,
`public/developers/{reference.html, openapi.yaml, lucilamon-partner.postman_collection.json}`. Después despliega el frontend y la API
(la API sirve el YAML en `/v1/partner-docs/openapi.yaml` desde su carpeta `docs/`).

La prueba `apps/api/src/partner-api/partner-docs.spec.ts` falla si el controlador y el YAML dejan de coincidir (rutas, permisos, eventos
de webhook) o si un ejemplo expone un campo interno. Si falla: regenera.

## Cuando cambian las respuestas de la API

Los ejemplos salen de una captura real. Para refrescarlos:

```bash
docker run -d --name lm-docs-pg -e POSTGRES_PASSWORD=docs -e POSTGRES_DB=lm_docs_test -p 55433:5432 postgres:16-alpine
# migraciones (la de pgvector se omite en una copia temporal si la imagen no trae la extensión), y los planes:
DATABASE_URL=postgresql://postgres:docs@localhost:55433/lm_docs_test npx prisma migrate deploy --schema=./apps/api/prisma/schema.prisma
DATABASE_URL=postgresql://postgres:docs@localhost:55433/lm_docs_test npx ts-node apps/api/prisma/seed-plans.ts
npx nest build api
cd scripts/partner-docs/capture && ./start_api.sh && sleep 15
node seed.js > seed.json && python3 capture.py        # crea captures.json y deliveries.json
cd .. && python3 sanitize.py capture/captures.json capture/deliveries.json examples.json
```

La base se llama `lm_docs_test`: nunca apuntes esta captura a una base con datos. Solo se simulan el almacenamiento, el reconocimiento facial y
el DNS: las respuestas de `searchByFace` y `verifyWorkspaceDomain` y los eventos de webhook emitidos por el procesamiento (`photo.processing.*`,
`upload.batch.completed|failed`, `analytics.report.ready`, `usage.threshold`, portada) se escriben a mano en `build_openapi.py` y
`texts_general.py` a partir del código que los emite.
