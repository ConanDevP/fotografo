# 🚀 Getting Started - Fotografos Platform

Esta guía te ayudará a configurar y ejecutar la plataforma completa con OCR y reconocimiento facial en tu entorno local.

## 🆕 What's New: Facial Recognition
The platform now includes **facial recognition** alongside OCR detection! Athletes can search for photos using their selfies, providing a backup when bib numbers aren't visible and enhanced search accuracy.

## 📋 Requisitos Previos

### **Software Necesario**
- **Node.js 20+** - [Descargar aquí](https://nodejs.org/)
- **PostgreSQL 14+** - [Descargar aquí](https://postgresql.org/download/)
- **Redis 6+** - [Descargar aquí](https://redis.io/download/)
- **Git** - [Descargar aquí](https://git-scm.com/)

### **Cuentas de Servicio (Recomendado)**
- **Cloudinary** - [Registrarse gratis](https://cloudinary.com/users/register/free)
- **Google AI Studio** - [Obtener API key gratuita](https://makersuite.google.com/app/apikey)
- **SendGrid** (opcional) - [Plan gratuito](https://sendgrid.com/pricing/)

---

## ⚡ Quick Start (5 minutos)

### **1. Clonar y Configurar**
```bash
# Clonar repositorio
git clone <repository-url>
cd fotografos-platform

# Instalar dependencias
npm install

# Configurar variables de entorno
cp .env.example .env
```

### **2. Configurar .env (Mínimo)**
```env
# Base de datos (ajustar según tu instalación)
DATABASE_URL="postgresql://postgres:password@localhost:5432/fotografos_db"

# Redis
REDIS_HOST="localhost"
REDIS_PORT=6379

# Demo mode (pagos simulados)
DEMO_PAYMENTS=true

# JWT Keys (usar estos para desarrollo)
JWT_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC..."
JWT_PUBLIC_KEY="-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA..."

# Cloudinary (registrarse gratis)
CLOUDINARY_CLOUD_NAME="your-cloud-name"
CLOUDINARY_API_KEY="your-api-key"
CLOUDINARY_API_SECRET="your-api-secret"

# Gemini AI (gratis hasta cierto límite)
GEMINI_API_KEY="your-gemini-api-key"
```

### **3. Configurar Base de Datos**
```bash
# Crear base de datos
createdb fotografos_db

# Ejecutar migraciones
npx prisma migrate dev
npx prisma generate
```

### **4. Ejecutar la Aplicación**
```bash
# Terminal 1: API
npm run start:dev

# Terminal 2: Worker (nueva terminal)
cd apps/worker
npm run start:dev
```

### **5. Verificar Instalación**
- API: http://localhost:8080/v1/events (debería devolver `{"data": []}`)
- Documentación: Abrir `docs/api-documentation.md`

---

## 🔧 Configuración Detallada

### **Generar JWT Keys**
```bash
# Generar private key
openssl genpkey -algorithm RSA -out private.pem -pkcs8 -pass pass:mypassword

# Generar public key
openssl rsa -pubout -in private.pem -out public.pem -passin pass:mypassword

# Copiar contenido (incluyendo -----BEGIN/END-----) a .env
```

### **Configurar PostgreSQL**
```sql
-- Conectar a PostgreSQL como superuser
psql -U postgres

-- Crear base de datos y usuario
CREATE DATABASE fotografos_db;
CREATE USER fotografos_user WITH PASSWORD 'fotografos_pass';
GRANT ALL PRIVILEGES ON DATABASE fotografos_db TO fotografos_user;

-- Conectar a la nueva base de datos
\c fotografos_db

-- Habilitar extensión UUID (si no está)
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
```

### **Configurar Redis**
```bash
# Ubuntu/Debian
sudo apt install redis-server
sudo systemctl start redis

# macOS con Homebrew
brew install redis
brew services start redis

# Windows
# Descargar desde: https://redis.io/docs/getting-started/installation/install-redis-on-windows/
```

---

## 🧪 Pruebas Rápidas

### **1. Registrar Fotógrafo**
```bash
curl -X POST http://localhost:8080/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "photographer@test.com",
    "password": "password123",
    "role": "PHOTOGRAPHER"
  }'
```

### **2. Crear Evento**
```bash
# Usar el token recibido del registro
curl -X POST http://localhost:8080/v1/events \
  -H "Authorization: Bearer YOUR_TOKEN_HERE" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Maratón Test",
    "date": "2025-06-01",
    "location": "Ciudad Test",
    "bibRules": {
      "minLen": 3,
      "maxLen": 4,
      "range": [1, 9999]
    },
    "pricing": {
      "singlePhoto": 500,
      "pack5": 2000,
      "currency": "EUR"
    }
  }'
```

### **3. Subir Foto de Prueba**
```bash
curl -X POST http://localhost:8080/v1/uploads/photo \
  -H "Authorization: Bearer YOUR_TOKEN_HERE" \
  -F "file=@/path/to/photo.jpg" \
  -F "eventId=YOUR_EVENT_ID"
```

---

## 📂 Estructura del Proyecto

```
fotografos-platform/
├── 📁 apps/
│   ├── 📁 api/                 # API REST (NestJS)
│   │   ├── 📁 src/
│   │   │   ├── 📁 auth/        # Autenticación JWT
│   │   │   ├── 📁 events/      # Gestión de eventos
│   │   │   ├── 📁 uploads/     # Subida de fotos
│   │   │   ├── 📁 photos/      # Gestión de fotos
│   │   │   ├── 📁 search/      # Búsqueda por dorsales
│   │   │   ├── 📁 payments/    # Sistema de pagos
│   │   │   ├── 📁 admin/       # Panel de administración
│   │   │   └── 📁 common/      # Servicios compartidos
│   │   └── 📁 prisma/          # Esquemas de base de datos
│   └── 📁 worker/              # Procesamiento asíncrono
│       └── 📁 src/
│           ├── 📁 queues/      # Procesadores de trabajos
│           └── 📁 services/    # OCR, imágenes, email
├── 📁 packages/
│   └── 📁 shared/              # Tipos y constantes compartidas
├── 📁 docs/                   # Documentación
└── 📄 docker-compose.yml      # Para desarrollo con Docker
```

---

## 🐳 Desarrollo con Docker

Si prefieres usar Docker para evitar instalaciones locales:

```bash
# Clonar y configurar .env (como arriba)
cp .env.example .env

# Ejecutar con Docker Compose
docker-compose up -d

# Ver logs
docker-compose logs -f

# Ejecutar migraciones
docker-compose exec api npx prisma migrate dev
```

---

## 🔍 Flujo de Trabajo Típico

### **1. Setup del Evento (Fotógrafo)**
1. Registrarse como `PHOTOGRAPHER`
2. Crear evento con reglas de dorsales
3. Configurar precios (foto individual, packs)

### **2. Procesamiento de Fotos**
1. Subir fotos (individual o lote)
2. Sistema procesa automáticamente:
   - Genera thumbnails y watermarks
   - OCR con Gemini para detectar dorsales
   - Organiza en carpetas por dorsal
   - Estado: `PENDING` → `PROCESSED`

### **3. Búsqueda y Compra (Atleta)**
1. Buscar por dorsal (sin registro)
2. Ver fotos con watermark
3. Comprar fotos (en demo mode es automático)
4. Descargar originales sin watermark

---

## 🎯 Endpoints Principales

### **Básicos**
- `GET /v1/events` - Listar eventos públicos
- `POST /v1/auth/register` - Registro de usuarios
- `POST /v1/auth/login` - Inicio de sesión

### **Upload (Requiere autenticación)**
- `POST /v1/uploads/photo` - Subir foto individual
- `POST /v1/uploads/photos/batch` - Subir múltiples fotos

### **Búsqueda (Público)**
- `GET /v1/events/:id/search/photos?bib=1234` - Buscar por dorsal
- `POST /v1/events/:id/search/subscribe` - Suscribirse a notificaciones

### **Pagos (Público)**
- `POST /v1/payments/orders` - Crear pedido
- `GET /v1/payments/orders/:id/download` - Descargar fotos compradas

### **Admin (Requiere permisos)**
- `GET /v1/admin/events/:id/metrics` - Métricas del evento
- `GET /v1/admin/system-stats` - Estadísticas del sistema

---

## ⚠️ Troubleshooting

### **Error: Cannot connect to database**
```bash
# Verificar que PostgreSQL esté corriendo
pg_isready -h localhost -p 5432

# Verificar conexión con credenciales
psql "postgresql://fotografos_user:fotografos_pass@localhost:5432/fotografos_db"
```

### **Error: Redis connection failed**
```bash
# Verificar Redis
redis-cli ping
# Debería responder: PONG
```

### **Error: Prisma migration failed**
```bash
# Regenerar cliente Prisma
npx prisma generate

# Reset de base de datos (¡cuidado en producción!)
npx prisma migrate reset
```

### **Error: Upload failed - Cloudinary**
- Verificar que las credenciales de Cloudinary sean correctas
- Verificar que el cloud name no tenga espacios o caracteres especiales

### **Error: OCR not working**
- Verificar que `GEMINI_API_KEY` esté configurado
- Verificar cuota de API de Gemini
- Ver logs del worker para errores específicos

---

## 📈 Monitoreo

### **Logs de la Aplicación**
```bash
# API logs
npm run start:dev

# Worker logs
cd apps/worker && npm run start:dev

# Ver logs específicos
docker-compose logs api
docker-compose logs worker
```

### **Métricas en Tiempo Real**
- `/v1/admin/queue-stats` - Estado de las colas
- `/v1/admin/system-stats` - Estadísticas generales
- `/v1/admin/events/:id/metrics` - Métricas por evento

### **Base de Datos**
```sql
-- Ver fotos por estado
SELECT status, COUNT(*) FROM photos GROUP BY status;

-- Ver dorsales más populares
SELECT bib, COUNT(*) as photo_count 
FROM photo_bibs 
GROUP BY bib 
ORDER BY photo_count DESC 
LIMIT 10;

-- Ver estadísticas de pedidos
SELECT status, COUNT(*), SUM(amount_cents) 
FROM orders 
GROUP BY status;
```

---

## 📞 Soporte

- 📖 **Documentación**: Ver carpeta `docs/`
- 🐛 **Bugs**: Abrir issue en el repositorio
- 💬 **Preguntas**: Contactar al equipo de desarrollo

---

## 🤖 Facial Recognition Setup

The platform includes facial recognition powered by **Face-API.js** running locally.

### **Face Model Files**
Face-API.js models are automatically downloaded when you first start the worker:

```bash
# Models are downloaded to:
node_modules/face-api.js/weights/
├── tiny_face_detector_model-*          # Face detection
├── face_landmark_68_model-*             # Facial landmarks  
├── face_recognition_model-*             # Face embeddings
└── age_gender_model-*                   # Age/gender estimation
```

**Total size**: ~7MB (downloaded once)

### **Verify Face Recognition**
Start the worker and look for this success message:

```bash
npx nest start worker --watch

# You should see:
[LOG] [FaceApiService] Loading Face-API models...
[LOG] [FaceApiService] Face-API models loaded successfully ✅
```

### **Face Recognition Features**
Once operational, the system provides:

1. **🔍 Search by Selfie**
   ```bash
   POST /v1/events/:id/search/photos/by-face
   # Upload selfie → Get all matching photos
   ```

2. **📊 Face Statistics** 
   ```bash
   GET /v1/events/:id/search/face-stats
   # Get detection stats for the event
   ```

3. **🔄 Hybrid Search**
   ```bash
   POST /v1/events/:id/search/photos/hybrid
   # Combine bib number + face recognition
   ```

### **Processing Flow**
When photos are uploaded, both systems work in parallel:

```
📸 Photo Upload
├── 🔢 OCR Processing (Gemini) → Detect bib numbers
└── 👤 Face Processing (Face-API) → Detect faces & create embeddings

🔍 Search Options:
├── Search by bib number (traditional)
├── Search by selfie (new!)
└── Hybrid search (combined accuracy)
```

### **Performance Characteristics**
- **Setup**: 2-5 seconds per photo (one-time processing)
- **Search**: 2-3 seconds for 2000+ faces  
- **Cost**: ~$0.0001 per search (local computation only)
- **Privacy**: Only mathematical vectors stored, no face images

### **Rate Limits**
Face recognition has separate rate limits:

```javascript
Daily Search Limits:
├── Anonymous users: 3 searches
├── Registered users: 10 searches  
├── Premium users: 100 searches
└── Photographers: Unlimited
```

---

## 🎉 ¡Listo para Empezar!

Una vez que tengas todo configurado, tu plataforma estará lista para:

1. ✅ **Subir fotos** con procesamiento automático
2. ✅ **Detectar dorsales** con OCR de Gemini
3. ✅ **🆕 Reconocimiento facial** con Face-API.js
4. ✅ **🆕 Búsqueda por selfie** de atletas
5. ✅ **Búsqueda instantánea** por dorsal
6. ✅ **🆕 Búsqueda híbrida** (dorsal + rostro)
7. ✅ **Compras simuladas** para testing
8. ✅ **Dashboard administrativo** completo

**Siguiente paso**: Revisar la [documentación de la API](./api-documentation.md) para implementar tu frontend o integrar con sistemas existentes.

### **🔗 Enlaces Útiles**
- 📖 [Face Recognition System Documentation](./face-recognition.md)
- 🔧 [API Documentation](./api-documentation.md)
- 💡 [Usage Examples](./examples.md)
- 🚀 [Deployment Guide](../README.md#deployment)