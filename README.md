# 📸 Fotografos Platform - Backend

Plataforma completa para fotógrafos de eventos deportivos con detección automática de dorsales usando OCR con Gemini AI.

## 🚀 **Características Principales**

### **Para Fotógrafos**
- ✅ Gestión completa de eventos deportivos
- ✅ Upload masivo de fotos a Cloudinary
- ✅ Procesamiento automático con OCR Gemini
- ✅ Organización automática por dorsales
- ✅ Corrección manual de dorsales detectados
- ✅ Dashboard con métricas y estadísticas
- ✅ Sistema de pagos integrado (modo demo)

### **Para Atletas**
- ✅ Búsqueda instantánea por dorsal
- ✅ **Búsqueda por reconocimiento facial (selfie)**
- ✅ **Búsqueda híbrida (dorsal + rostro)**
- ✅ Previsualizaciones con marca de agua
- ✅ Suscripción a notificaciones automáticas
- ✅ Compra y descarga sin marca de agua
- ✅ Emails con fotos encontradas

### **Sistema Automático**
- ✅ OCR con Gemini AI (flash + pro strategies)
- ✅ **Reconocimiento facial con Face-API.js**
- ✅ **Búsqueda por foto del atleta (selfie)**
- ✅ Cola de procesamiento con Redis + BullMQ
- ✅ Generación automática de thumbnails y watermarks
- ✅ Validación de dorsales según reglas del evento
- ✅ Notificaciones automáticas por email

## 🏗️ **Arquitectura**

```
📦 fotografos-platform/
├── apps/
│   ├── api/          # API REST (NestJS)
│   └── worker/       # Procesamiento asíncrono
├── packages/
│   └── shared/       # Tipos y constantes compartidas
└── docs/            # Documentación
```

## 🛠️ **Stack Tecnológico**

- **Runtime**: Node.js 20+
- **Framework**: NestJS (TypeScript)
- **Base de datos**: PostgreSQL 14+ + Prisma ORM
- **Cache/Colas**: Redis + BullMQ
- **Almacenamiento**: Cloudinary (imágenes + CDN)
- **OCR/AI**: Google Gemini 1.5 (flash/pro)
- **Reconocimiento Facial**: Face-API.js (local)
- **Autenticación**: JWT (RS256)
- **Pagos**: Stripe (modo demo habilitado)
- **Email**: SendGrid/SES

## ⚡ **Quick Start**

### **1. Configurar Variables de Entorno**
```bash
cp .env.example .env
# Completar todas las variables necesarias
```

### **2. Instalar Dependencias**
```bash
npm install
```

### **3. Configurar Base de Datos**
```bash
npx prisma migrate dev
npx prisma generate
```

### **4. Ejecutar en Desarrollo**

**Terminal 1 - API:**
npx nest start api --watch
```bash
npm run start:dev
```

**Terminal 2 - Worker:**
```bash
 npx nest start worker --watch

cd apps/worker
npm run start:dev
```

## 🔧 **Variables de Entorno Principales**

```env
# Base de datos
DATABASE_URL="postgresql://user:pass@localhost:5432/fotografos"

# Redis
REDIS_HOST="localhost"
REDIS_PORT=6379

# Cloudinary
CLOUDINARY_CLOUD_NAME=""
CLOUDINARY_API_KEY=""
CLOUDINARY_API_SECRET=""

# Gemini AI
GEMINI_API_KEY=""

# Demo Mode (pagos simulados)
DEMO_PAYMENTS=true

# JWT Keys (generar con openssl)
JWT_PRIVATE_KEY=""
JWT_PUBLIC_KEY=""

# Email
SENDGRID_API_KEY=""
EMAIL_FROM="noreply@tu-dominio.com"
```

## 📋 **API Endpoints Principales**

### **🔐 Autenticación**
```http
POST   /v1/auth/register
POST   /v1/auth/login
POST   /v1/auth/refresh
```

### **📅 Eventos**
```http
GET    /v1/events
POST   /v1/events
GET    /v1/events/:id
PATCH  /v1/events/:id
GET    /v1/events/:id/photos          # Obtener todas las fotos del evento
```

### **📸 Upload de Fotos**
```http
POST   /v1/uploads/photo
POST   /v1/uploads/photos/batch
```

### **🔍 Búsqueda**
```http
GET    /v1/events/:id/search/photos?bib=1234
POST   /v1/events/:id/search/photos/by-face
POST   /v1/events/:id/search/photos/hybrid
GET    /v1/events/:id/search/face-stats
POST   /v1/events/:id/search/subscribe
POST   /v1/events/:id/search/email-photos
```

### **💰 Pagos (Demo Mode)**
```http
POST   /v1/payments/orders
GET    /v1/payments/orders/:id
GET    /v1/payments/orders/:id/download
```

### **⚙️ Admin**
```http
GET    /v1/admin/events/:id/metrics
GET    /v1/admin/system-stats
GET    /v1/admin/queue-stats
```

## 🔄 **Flujo de Trabajo**

### **1. Setup del Evento**
```json
POST /v1/events
{
  "name": "Maratón Madrid 2025",
  "date": "2025-03-15",
  "bibRules": {
    "minLen": 3,
    "maxLen": 5,
    "range": [1, 9999]
  },
  "pricing": {
    "singlePhoto": 500,
    "pack5": 2000,
    "currency": "EUR"
  }
}
```

### **2. Upload de Fotos**
```bash
curl -X POST /v1/uploads/photos/batch \
  -H "Authorization: Bearer $TOKEN" \
  -F "files=@photo1.jpg" \
  -F "files=@photo2.jpg" \
  -F "eventId=uuid-here"
```

### **3. Búsqueda Instantánea**
```http
GET /v1/events/:id/search/photos?bib=1234
```

### **4. Compra (Demo Mode)**
```json
POST /v1/payments/orders
{
  "eventId": "uuid",
  "items": [
    { "type": "PHOTO", "photoId": "uuid" },
    { "type": "PACKAGE", "packageType": "pack5" }
  ]
}
```

## 📊 **Métricas y Monitoreo**

El sistema incluye métricas completas para fotógrafos y administradores:

- **Fotos**: Total, procesadas, fallidas, tasa de procesamiento
- **Dorsales**: Total detectados, únicos, precisión OCR
- **Ventas**: Pedidos, conversión, ingresos promedio
- **Colas**: Estado del procesamiento en tiempo real

## 🔒 **Seguridad**

- ✅ Autenticación JWT con claves RS256
- ✅ Rate limiting por endpoint
- ✅ Validación estricta de datos (Zod + class-validator)
- ✅ CORS configurado
- ✅ Helmet para headers de seguridad
- ✅ URLs firmadas para descargas
- ✅ Logs de auditoría completos

## 🧪 **Testing**

```bash
# Unit tests
npm run test

# Integration tests
npm run test:e2e

# Coverage
npm run test:cov
```

## 🚀 **Deployment**

### **Docker**
```bash
# Build
docker build -t fotografos-api .
docker build -t fotografos-worker ./apps/worker

# Run
docker-compose up -d
```

### **Variables de Producción**
```env
NODE_ENV=production
DEMO_PAYMENTS=false
STRIPE_SECRET_KEY="sk_live_..."
LOG_LEVEL="warn"
```

## 📈 **Performance**

- **Upload**: Directo a Cloudinary (sin pasar por servidor)
- **OCR**: Procesamiento paralelo con workers
- **Búsqueda**: Carpetas organizadas + índices de DB optimizados
- **CDN**: Cloudinary para entrega global de imágenes
- **Cache**: Redis para sesiones y datos temporales

## 🛣️ **Roadmap**

### **✅ Completado**
- Sistema completo de dorsales con OCR
- Pagos en modo demo
- Dashboard de administración
- Organización automática por carpetas

### **🔄 En Desarrollo**
- Stripe production mode
- Tests automatizados
- Documentación OpenAPI

### **🔮 Futuro**
- Reconocimiento facial (módulo premium)
- Mobile app
- Analytics avanzados
- Integración con timing systems

## 🤝 **Contribuir**

1. Fork del proyecto
2. Crear feature branch (`git checkout -b feature/nueva-funcionalidad`)
3. Commit changes (`git commit -m 'Agregar nueva funcionalidad'`)
4. Push to branch (`git push origin feature/nueva-funcionalidad`)
5. Abrir Pull Request

## 📄 **Licencia**

Este proyecto está bajo la Licencia MIT - ver el archivo [LICENSE](LICENSE) para detalles.

---

**🔗 Links Útiles:**
- [Documentación de Cloudinary](https://cloudinary.com/documentation)
- [Google Gemini API](https://ai.google.dev/docs)
- [NestJS Documentation](https://docs.nestjs.com)
- [Prisma Docs](https://www.prisma.io/docs)
