# 🚀 Migración a Neon PostgreSQL

Esta guía te ayudará a migrar la base de datos de Railway/Docker a Neon PostgreSQL.

## ¿Por qué Neon?

- **Serverless**: Escala automáticamente según demanda
- **Connection Pooling**: Maneja miles de conexiones simultáneas
- **pgvector**: Soporte nativo para embeddings faciales
- **Branching**: Crea copias de la BD para desarrollo/staging
- **Cost-effective**: Pago por uso, sin mínimo mensual

## 📋 Pasos de Migración

### 1. Crear cuenta en Neon

1. Ve a [https://console.neon.tech](https://console.neon.tech)
2. Regístrate con GitHub o email
3. Crea un nuevo proyecto:
   - **Name**: `fotocorredor-prod` (o el nombre que prefieras)
   - **Region**: Selecciona la más cercana a tus usuarios (ej: `us-east-2` para Latinoamérica)
   - **PostgreSQL Version**: 16 (recomendado)

### 2. Obtener Connection String

1. En el dashboard de Neon, ve a tu proyecto
2. Click en **"Connection Details"**
3. Selecciona **"Pooled connection"** (IMPORTANTE)
4. Copia el connection string, se ve así:
   ```
   postgresql://neondb_owner:AbCdEf123456@ep-cool-name-123456-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require
   ```

### 3. Habilitar pgvector (para embeddings faciales)

En la consola SQL de Neon, ejecuta:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

### 4. Actualizar variables de entorno

Edita tu archivo `.env`:

```bash
# Reemplaza la URL de Railway con la de Neon
DATABASE_URL="postgresql://neondb_owner:TU_PASSWORD@ep-xxx-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require"
```

### 5. Ejecutar migraciones

```bash
cd apps/api

# Generar cliente Prisma
npx prisma generate

# Aplicar migraciones a Neon
npx prisma migrate deploy

# O si es la primera vez, crear las tablas
npx prisma db push
```

### 6. (Opcional) Migrar datos existentes

Si tienes datos en Railway que quieres conservar:

```bash
# Exportar de Railway
pg_dump "postgresql://postgres:PASSWORD@switchyard.proxy.rlwy.net:16390/railway" > backup.sql

# Importar a Neon
psql "postgresql://neondb_owner:PASSWORD@ep-xxx.us-east-2.aws.neon.tech/neondb?sslmode=require" < backup.sql
```

## 🔧 Configuración Optimizada para Alta Carga

### Connection Pooling

Neon usa PgBouncer internamente. Para optimizar:

```typescript
// prisma.service.ts - Ya está configurado correctamente
const prisma = new PrismaClient({
  log: [{ level: 'error', emit: 'event' }],
});
```

### Parámetros de conexión recomendados

Agrega estos parámetros a tu DATABASE_URL:

```
?sslmode=require&connection_limit=20&pool_timeout=30
```

URL completa:
```
postgresql://user:pass@host/db?sslmode=require&connection_limit=20&pool_timeout=30
```

## 📊 Monitoreo

### Dashboard de Neon

- Ve a **Monitoring** en la consola de Neon
- Observa:
  - **Compute hours**: Uso de CPU
  - **Storage**: Espacio usado
  - **Connections**: Conexiones activas

### Queries lentas

```sql
-- Ver queries más lentas
SELECT query, calls, mean_time, total_time
FROM pg_stat_statements
ORDER BY mean_time DESC
LIMIT 10;
```

## 🌿 Branching (Desarrollo/Staging)

Neon permite crear "branches" de tu base de datos:

1. En la consola, click en **"Branches"**
2. Click **"Create Branch"**
3. Nombra: `development` o `staging`
4. Usa el connection string de esa branch para desarrollo

Esto te da una copia completa de la BD sin afectar producción.

## 💰 Estimación de Costos

| Uso | Storage | Compute | Costo/mes |
|-----|---------|---------|-----------|
| 10K fotos | ~3 GB | ~50 CU-h | ~$7 |
| 50K fotos | ~10 GB | ~150 CU-h | ~$22 |
| 100K fotos | ~20 GB | ~300 CU-h | ~$45 |

## ⚠️ Troubleshooting

### Error: "too many connections"

Asegúrate de usar la URL con `-pooler` en el host:
```
ep-xxx-pooler.us-east-2.aws.neon.tech  ✅
ep-xxx.us-east-2.aws.neon.tech         ❌
```

### Error: "connection timeout"

Agrega `connect_timeout=30` a la URL:
```
?sslmode=require&connect_timeout=30
```

### Error: "SSL required"

Asegúrate de tener `sslmode=require` en la URL.

## ✅ Checklist Final

- [ ] Cuenta creada en Neon
- [ ] Proyecto creado
- [ ] pgvector habilitado
- [ ] Connection string copiado (pooled)
- [ ] `.env` actualizado
- [ ] `prisma generate` ejecutado
- [ ] `prisma migrate deploy` ejecutado
- [ ] Datos migrados (si aplica)
- [ ] Aplicación probada

---

**¿Problemas?** Revisa la [documentación oficial de Neon](https://neon.tech/docs)
