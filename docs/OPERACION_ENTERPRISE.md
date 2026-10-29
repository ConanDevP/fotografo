# Operación de clientes Enterprise

Guía interna: cómo se lleva un cliente de API desde la primera conversación hasta la renovación.

## Ciclo de vida

| Etapa | Estado | Qué haces | Qué hace el sistema |
|---|---|---|---|
| Solicitud | `PROSPECT` | Revisas en `/admin/enterprise` | Registra la solicitud y te avisa por correo |
| **Piloto** | `PILOT` | Botón **Abrir piloto (30 días)** | Topes bajos (300 fotos, 3.000 solicitudes), claves `lm_test_`, sin originales, fecha de fin |
| **Contrato** | `ACTIVE` | Fijas precio anual, cupos, exceso y fechas; **Guardar contrato** | Las claves de prueba dejan de valer; el cliente crea claves `lm_live_` |
| Facturación | `ACTIVE` | **Facturar ahora** (o espera al día 1) | Emite por Stripe la cuota anual y el exceso del mes anterior; es idempotente |
| Suspensión / fin | `SUSPENDED` / `ENDED` | Cambias el estado | La API deja de responder |

## Qué se mide y qué se limita

- **Fotografías por año contractual** (libro `usage_ledger`): el año empieza en el aniversario del contrato.
  - Sin `allowOverage`: la subida que superaría el cupo se rechaza (`403 PHOTO_LIMIT_REACHED`).
  - Con `allowOverage` y `overagePhotoCents`: se deja pasar y el exceso se factura cada mes.
- **Solicitudes API y búsquedas faciales por mes**: `429` al agotarse.
- **Avisos**: al 80 % y al 100 % de cada tope, por correo y webhook `usage.threshold` (cada 30 min, una vez por periodo).
- **Procesamiento prioritario**: los trabajos del cliente entran en la cola con prioridad 1 (los normales, 10).
- **Retención**: pasados `retentionDays` desde la fecha del evento se borra el evento, salvo que tenga compras. Aviso 14 días antes.

## Variables de entorno

| Variable | Para qué |
|---|---|
| `STRIPE_SECRET_KEY` | Facturación Enterprise (sin ella no se emite nada y se avisa en el log) |
| `RETENTION_ENFORCE=true` | **Activa el borrado real.** Sin ella la retención solo simula y deja `RETENTION_DRY_RUN` en auditoría |
| `AI_PRICING_JSON` | Precios de IA por millón de tokens para el informe de costes |

## Puesta en marcha (una vez)

1. `npx prisma migrate deploy` (crea `usage_ledger`, `ai_usage_logs`, `enterprise_invoices` y los campos de exceso; cuenta las fotos que ya existen).
2. `npm run seed:plans` para crear el plan **Business** y sincronizar sus precios con Stripe.
3. Revisa en `RETENTION_DRY_RUN` (tabla de auditoría) qué se borraría antes de activar `RETENTION_ENFORCE`.

## Informes

- Coste de IA: `GET /v1/admin/system/reports/ai-costs?days=30`.
- Consumo del cliente: panel del cliente o `GET /v1/partner/usage`.

## Pruebas de integración (PostgreSQL real)

Además de las pruebas unitarias hay dos suites que corren contra una base real
(`enterprise.integration.spec.ts` y `enterprise-lifecycle.integration.spec.ts`): cupo de fotos y
eventos, facturación sin duplicados, avisos de uso, piloto, claves de prueba, prioridad, retención y
equipo. Solo corren si defines `E2E_DATABASE_URL`, y se niegan a usar una base cuyo nombre no
contenga `e2e` o `test`.

```bash
docker run -d --name lm-e2e-pg -e POSTGRES_PASSWORD=e2e -e POSTGRES_DB=lm_e2e -p 55432:5432 pgvector/pgvector:pg16
DATABASE_URL=postgresql://postgres:e2e@localhost:55432/lm_e2e \
  npx prisma migrate deploy --schema=./apps/api/prisma/schema.prisma
E2E_DATABASE_URL=postgresql://postgres:e2e@localhost:55432/lm_e2e npx jest enterprise
```

Se pueden repetir sin limpiar la base. Stripe y el correo van simulados; lo que se prueba es la
lógica y el SQL, no los servicios externos.
