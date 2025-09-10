# 🚀 Worker Scaling Configuration Guide

## Environment Variables para Concurrency

### Para desarrollo/testing (pocas fotos):
```bash
WORKER_CONCURRENCY=4           # Procesar 4 fotos simultáneamente  
FACE_WORKER_CONCURRENCY=3      # 3 face recognition simultáneos
```

### Para producción pequeña (hasta 100 fotos):
```bash
WORKER_CONCURRENCY=2           # Conservativo - 2 fotos simultáneas
FACE_WORKER_CONCURRENCY=2      # 2 face recognition simultáneos
```

### Para producción grande (1000-5000 fotos):
```bash
WORKER_CONCURRENCY=1           # ULTRA CONSERVATIVO - 1 foto por vez
FACE_WORKER_CONCURRENCY=1      # 1 face recognition por vez
```

## 📊 Cálculo de Recursos por Foto

**Cada foto consume:**
- ~500KB-2MB descarga de R2
- ~100-200MB RAM en Sharp processing
- ~500KB-1MB upload de vuelta a R2
- 1 llamada a Gemini (rate limited)
- 1 llamada a face API externa

**Con WORKER_CONCURRENCY=4:**
- Memoria pico: ~800MB-1.6GB
- Ancho de banda: ~8MB-16MB concurrent
- 4 llamadas Gemini simultáneas

## 🎯 Recomendaciones por Escenario

### Testing (6-20 fotos):
```bash
WORKER_CONCURRENCY=4
FACE_WORKER_CONCURRENCY=3
```
✅ Rápido, recursos manejables

### Eventos pequeños (50-200 fotos):
```bash
WORKER_CONCURRENCY=3
FACE_WORKER_CONCURRENCY=2  
```
✅ Balance velocidad/estabilidad

### Eventos medianos (500-1000 fotos):
```bash
WORKER_CONCURRENCY=2
FACE_WORKER_CONCURRENCY=1
```
✅ Estable, procesamiento steady

### Eventos grandes (2000-5000 fotos):
```bash
WORKER_CONCURRENCY=1
FACE_WORKER_CONCURRENCY=1
```
✅ Ultra estable, lento pero seguro

## 🔥 Monitoreo de Sistema

**Indicadores de sobrecarga:**
- RAM > 80% utilización
- CPU > 90% constant
- Network timeouts aumentando
- Redis connection errors
- Gemini rate limit errors

**Si ves sobrecarga, REDUCIR concurrency inmediatamente:**
```bash
WORKER_CONCURRENCY=1
FACE_WORKER_CONCURRENCY=1
```

## ⚡ Scaling Horizontal (Futuro)

Para 5000+ fotos, considerar:
1. Múltiples workers en diferentes máquinas
2. Load balancing Redis
3. Dedicated Gemini API keys por worker
4. Chunked processing con delays

## 🛡️ Configuración Actual Segura

**Default values (sin env vars):**
- WORKER_CONCURRENCY=2 (conservativo)
- FACE_WORKER_CONCURRENCY=2 (conservativo)

**Para tus tests actuales (6 fotos):**
```bash
WORKER_CONCURRENCY=3
FACE_WORKER_CONCURRENCY=2
```