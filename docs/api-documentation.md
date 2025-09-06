# 📚 API Documentation - Fotografos Platform

## 🔗 Base URL
```
Development: http://localhost:8080/v1
Production: https://api.fotografos.com/v1
```

## 🔐 Authentication

La API usa JWT Bearer tokens. Incluye el token en el header:
```http
Authorization: Bearer <your-jwt-token>
```

### Obtener Token
```http
POST /auth/login
Content-Type: application/json

{
  "email": "photographer@example.com",
  "password": "password123"
}
```

**Response:**
```json
{
  "data": {
    "tokens": {
      "accessToken": "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...",
      "refreshToken": "a1b2c3d4e5f6..."
    },
    "user": {
      "id": "uuid-here",
      "email": "photographer@example.com",
      "role": "PHOTOGRAPHER",
      "createdAt": "2025-01-01T00:00:00Z"
    }
  }
}
```

---

## 🔐 Authentication Endpoints

### Register User
```http
POST /auth/register
```

**Body:**
```json
{
  "email": "user@example.com",
  "password": "password123",
  "role": "PHOTOGRAPHER" // opcional: ATHLETE, PHOTOGRAPHER, ADMIN
}
```

### Login
```http
POST /auth/login
```

**Body:**
```json
{
  "email": "user@example.com", 
  "password": "password123"
}
```

### Refresh Token
```http
POST /auth/refresh
```

**Body:**
```json
{
  "refreshToken": "your-refresh-token"
}
```

### Logout
```http
POST /auth/logout
```

**Body:**
```json
{
  "refreshToken": "your-refresh-token"
}
```

---

## 📅 Events Endpoints

### List Events
```http
GET /events?page=1&limit=20
```

**Response:**
```json
{
  "data": [
    {
      "id": "event-uuid",
      "name": "Maratón Madrid 2025",
      "slug": "maraton-madrid-2025",
      "date": "2025-03-15",
      "location": "Madrid, España",
      "imageUrl": "https://res.cloudinary.com/.../events/event-id/cover/event-cover.jpg",
      "owner": {
        "id": "user-uuid",
        "email": "photographer@example.com",
        "role": "PHOTOGRAPHER"
      },
      "_count": {
        "photos": 250
      },
      "createdAt": "2025-01-01T00:00:00Z"
    }
  ],
  "meta": {
    "pagination": {
      "page": 1,
      "limit": 20,
      "total": 50,
      "pages": 3
    }
  }
}
```

### Create Event
```http
POST /events
Authorization: Bearer <token>
```

**Body:**
```json
{
  "name": "Maratón Madrid 2025",
  "date": "2025-03-15",
  "location": "Madrid, España",
  "bibRules": {
    "minLen": 3,
    "maxLen": 5,
    "range": [1, 9999],
    "regex": "^[0-9]+$"
  },
  "pricing": {
    "singlePhoto": 500,
    "pack5": 2000,
    "pack10": 3500,
    "allPhotos": 5000,
    "currency": "EUR"
  }
}
```

### Get Event
```http
GET /events/:id
```

### Update Event
```http
PATCH /events/:id
Authorization: Bearer <token>
```

### Delete Event
```http
DELETE /events/:id
Authorization: Bearer <token>
```

### Get All Event Photos (Dashboard)
```http
GET /events/:id/photos
Authorization: Bearer <token>
```

**🎯 Use Case**: Dashboard del fotógrafo para ver todas las fotos subidas al evento, con stats de procesamiento y gestión de contenido.

**Query Parameters:**
- `page` (optional): Número de página (default: 1)
- `limit` (optional): Fotos por página (default: 50, max: 100)
- `status` (optional): Filtrar por estado: `PENDING`, `PROCESSED`, `FAILED`

**Authorization**: Solo PHOTOGRAPHER (dueño del evento) o ADMIN

**Response:**
```json
{
  "data": [
    {
      "id": "photo-uuid",
      "cloudinaryId": "events/event-id/original/photo-id",
      "originalUrl": "https://res.cloudinary.com/.../original.jpg",
      "thumbUrl": "https://res.cloudinary.com/.../thumb.jpg",
      "watermarkUrl": "https://res.cloudinary.com/.../watermark.jpg",
      "width": 4000,
      "height": 6000,
      "status": "PROCESSED",
      "takenAt": "2025-09-05T10:15:00Z",
      "createdAt": "2025-09-05T10:20:00Z",
      "photographer": {
        "id": "photographer-uuid",
        "email": "fotografo@email.com"
      },
      "detectedBibs": [
        {
          "bib": "440",
          "confidence": 0.99,
          "bbox": [392, 427, 49, 40],
          "source": "GEMINI"
        }
      ],
      "bibCount": 1
    }
  ],
  "meta": {
    "pagination": {
      "page": 1,
      "limit": 50,
      "total": 125,
      "pages": 3
    },
    "total": 125,
    "pending": 15,
    "processed": 100,
    "failed": 10
  }
}
```

**Examples:**
```bash
# Todas las fotos del evento
GET /events/13e7b6fb-d59b-49fe-a20f-896a6de47592/photos

# Solo fotos procesadas, página 2
GET /events/13e7b6fb-d59b-49fe-a20f-896a6de47592/photos?status=PROCESSED&page=2

# Fotos fallidas para reprocesamiento
GET /events/13e7b6fb-d59b-49fe-a20f-896a6de47592/photos?status=FAILED&limit=10
```

**🔍 Key Features:**
- ✅ **Paginación completa** con stats de procesamiento
- ✅ **Filtrado por status** para troubleshooting
- ✅ **Info completa de cada foto**: thumbnails, watermarks, dorsales detectados
- ✅ **Métricas en tiempo real**: pending/processed/failed counts
- ✅ **Autorización granular**: Solo dueño del evento o admin

### Upload Event Image
```http
POST /events/:id/image
Authorization: Bearer <token>
Content-Type: multipart/form-data
```

**🎯 Use Case**: Subir imagen de portada para el evento.

**Form Data:**
```
image: (image file - JPG/PNG, max 5MB)
```

**Authorization**: PHOTOGRAPHER (dueño del evento) o ADMIN

**Response:**
```json
{
  "data": {
    "id": "event-uuid",
    "name": "Maratón Madrid 2025",
    "slug": "maraton-madrid-2025",
    "date": "2025-03-15",
    "location": "Madrid, España",
    "imageUrl": "https://res.cloudinary.com/.../events/event-id/cover/event-cover.jpg",
    "owner": {
      "id": "user-uuid",
      "email": "photographer@example.com",
      "role": "PHOTOGRAPHER"
    },
    "_count": {
      "photos": 125
    },
    "createdAt": "2025-01-01T00:00:00Z"
  }
}
```

### Remove Event Image
```http
DELETE /events/:id/image
Authorization: Bearer <token>
```

**🎯 Use Case**: Eliminar imagen de portada del evento.

**Authorization**: PHOTOGRAPHER (dueño del evento) o ADMIN

---

## 🔍 Browse Event Photos (Authenticated Users)

### Browse Event Photos with Watermark
```http
GET /public/events/:eventId/photos
Authorization: Bearer <token>
```

**🎯 Use Case**: Permitir a atletas, administradores y fotógrafos navegar todas las fotos del evento con watermark para visualización.

**Query Parameters:**
- `page` (optional): Número de página (default: 1)
- `limit` (optional): Fotos por página (default: 50, max: 100)

**Authorization**: ATHLETE, PHOTOGRAPHER, o ADMIN

**Response:**
```json
{
  "data": [
    {
      "id": "photo-uuid",
      "eventId": "event-uuid",
      "watermarkUrl": "https://res.cloudinary.com/.../watermark.jpg",
      "thumbUrl": "https://res.cloudinary.com/.../thumb.jpg",
      "width": 4000,
      "height": 6000,
      "takenAt": "2025-09-05T10:15:00Z",
      "createdAt": "2025-09-05T10:20:00Z",
      "photographer": {
        "id": "photographer-uuid",
        "email": "fotografo@email.com"
      },
      "detectedBibs": [
        {
          "bib": "440",
          "confidence": 0.99,
          "source": "GEMINI"
        }
      ],
      "bibCount": 1
    }
  ],
  "meta": {
    "pagination": {
      "page": 1,
      "limit": 50,
      "total": 125,
      "pages": 3
    },
    "total": 125
  }
}
```

### Search Photos by Bib with Watermark
```http
GET /public/events/:eventId/photos/search?bib=1234
Authorization: Bearer <token>
```

**🎯 Use Case**: Permitir buscar fotos de un dorsal específico con watermark para visualización.

**Query Parameters:**
- `bib` (required): Número de dorsal
- `page` (optional): Número de página (default: 1)
- `limit` (optional): Fotos por página (default: 20, max: 50)

**Authorization**: ATHLETE, PHOTOGRAPHER, o ADMIN

**Response:**
```json
{
  "data": [
    {
      "id": "photo-uuid",
      "eventId": "event-uuid",
      "watermarkUrl": "https://res.cloudinary.com/.../watermark.jpg",
      "thumbUrl": "https://res.cloudinary.com/.../thumb.jpg",
      "width": 4000,
      "height": 6000,
      "takenAt": "2025-09-05T10:15:00Z",
      "createdAt": "2025-09-05T10:20:00Z",
      "photographer": {
        "id": "photographer-uuid",
        "email": "fotografo@email.com"
      },
      "detectedBibs": [
        {
          "bib": "1234",
          "confidence": 0.95,
          "source": "GEMINI"
        }
      ],
      "bibCount": 1
    }
  ],
  "meta": {
    "pagination": {
      "page": 1,
      "limit": 20,
      "total": 8,
      "pages": 1
    },
    "total": 8
  }
}
```

**Examples:**
```bash
# Navegar todas las fotos del evento con watermark
GET /public/events/13e7b6fb-d59b-49fe-a20f-896a6de47592/photos

# Buscar fotos de dorsal específico
GET /public/events/13e7b6fb-d59b-49fe-a20f-896a6de47592/photos/search?bib=1234

# Buscar con paginación
GET /public/events/13e7b6fb-d59b-49fe-a20f-896a6de47592/photos/search?bib=1234&page=2&limit=10
```

**🔍 Key Features:**
- ✅ **Solo fotos con watermark** para visualización segura
- ✅ **Autenticación requerida** para atletas, administradores y fotógrafos
- ✅ **Paginación completa** con límites apropiados
- ✅ **Filtrado por dorsal** para búsquedas específicas
- ✅ **Información completa** de dorsales detectados y confianza
- ✅ **URLs optimizadas** tanto thumbnail como watermark

---

## 📸 Upload Endpoints

### Upload Single Photo
```http
POST /uploads/photo
Authorization: Bearer <token>
Content-Type: multipart/form-data
```

**Form Data:**
```
file: (image file)
eventId: "event-uuid"
takenAt: "2025-03-15T10:30:00Z" (opcional)
```

**Response:**
```json
{
  "data": {
    "photoId": "photo-uuid",
    "cloudinaryId": "events/event-id/original/photo-id",
    "originalUrl": "https://res.cloudinary.com/...",
    "width": 4000,
    "height": 3000
  }
}
```

### Upload Multiple Photos
```http
POST /uploads/photos/batch
Authorization: Bearer <token>
Content-Type: multipart/form-data
```

**Form Data:**
```
files: (multiple image files)
eventId: "event-uuid"
```

**Response:**
```json
{
  "data": {
    "successful": [
      {
        "photoId": "photo-uuid-1",
        "cloudinaryId": "...",
        "originalUrl": "https://...",
        "width": 4000,
        "height": 3000
      }
    ],
    "errors": [
      {
        "fileIndex": 2,
        "fileName": "invalid-photo.txt",
        "error": "Formato de archivo no válido"
      }
    ],
    "total": 5,
    "successCount": 4,
    "errorCount": 1
  }
}
```

---

## 🔍 Search Endpoints

### Search Photos by Bib (All Types)
```http
GET /events/:eventId/search/photos?bib=1234
```

**🎯 Use Case**: Buscar fotos de un dorsal específico con todas las URLs (original, watermark, thumbnail).

**Query Parameters:**
- `bib` (required): Número de dorsal
- `limit` (optional): Número de resultados (default: 20, max 100)
- `cursor` (optional): Para paginación cursor-based

**Response:**
```json
{
  "data": [
    {
      "photoId": "photo-uuid",
      "thumbUrl": "https://res.cloudinary.com/.../thumb/...",
      "watermarkUrl": "https://res.cloudinary.com/.../watermark/...",
      "originalUrl": "https://res.cloudinary.com/.../original/...",
      "confidence": 0.95,
      "takenAt": "2025-03-15T10:30:00Z"
    }
  ],
  "meta": {
    "total": 8,
    "cursor": "eyJjb25maWRlbmNlIjowLjk1..."
  }
}
```

### Search Original Photos by Bib
```http
GET /events/:eventId/search/photos/original?bib=1234
```

**🎯 Use Case**: Obtener solo las fotos originales (sin marca de agua) de un dorsal específico.

**🔒 Security**: Solo retorna URLs originales, requiere autorización especial.

**Query Parameters:**
- `bib` (required): Número de dorsal
- `limit` (optional): Número de resultados (default: 20, max 100)
- `cursor` (optional): Para paginación cursor-based

**Response:**
```json
{
  "data": [
    {
      "photoId": "photo-uuid",
      "originalUrl": "https://res.cloudinary.com/.../original/...",
      "thumbUrl": "",
      "watermarkUrl": "",
      "confidence": 0.95,
      "takenAt": "2025-03-15T10:30:00Z"
    }
  ],
  "meta": {
    "total": 8,
    "cursor": "eyJjb25maWRlbmNlIjowLjk1..."
  }
}
```

### Search Watermark Photos by Bib
```http
GET /events/:eventId/search/photos/watermark?bib=1234
```

**🎯 Use Case**: Obtener solo las fotos con marca de agua de un dorsal específico.

**🔒 Security**: Solo retorna URLs de watermark, no las originales.

**Query Parameters:**
- `bib` (required): Número de dorsal
- `limit` (optional): Número de resultados (default: 20, max 100)
- `cursor` (optional): Para paginación cursor-based

**Response:**
```json
{
  "data": [
    {
      "photoId": "photo-uuid",
      "watermarkUrl": "https://res.cloudinary.com/.../watermark/...",
      "thumbUrl": "",
      "originalUrl": "",
      "confidence": 0.95,
      "takenAt": "2025-03-15T10:30:00Z"
    }
  ],
  "meta": {
    "total": 8,
    "cursor": "eyJjb25maWRlbmNlIjowLjk1..."
  }
}
```

### Search Thumbnail Photos by Bib
```http
GET /events/:eventId/search/photos/thumb?bib=1234
```

**🎯 Use Case**: Obtener solo los thumbnails de un dorsal específico.

**🔒 Security**: Solo retorna URLs de thumbnail, no las originales.

**Query Parameters:**
- `bib` (required): Número de dorsal
- `limit` (optional): Número de resultados (default: 20, max 100)
- `cursor` (optional): Para paginación cursor-based

**Response:**
```json
{
  "data": [
    {
      "photoId": "photo-uuid",
      "thumbUrl": "https://res.cloudinary.com/.../thumb/...",
      "watermarkUrl": "",
      "originalUrl": "",
      "confidence": 0.95,
      "takenAt": "2025-03-15T10:30:00Z"
    }
  ],
  "meta": {
    "total": 8,
    "cursor": "eyJjb25maWRlbmNlIjowLjk1..."
  }
}
```

### Get All Event Photos with Watermark
```http
GET /events/:eventId/search/all-photos/watermark
```

**🎯 Use Case**: Obtener todas las fotos del evento con marca de agua para navegación general.

**🔒 Security**: Solo retorna URLs de watermark, ideal para galería pública.

**Query Parameters:**
- `limit` (optional): Número de resultados (default: 20, max 100)
- `cursor` (optional): Para paginación cursor-based

**Response:**
```json
{
  "data": [
    {
      "photoId": "photo-uuid-1",
      "watermarkUrl": "https://res.cloudinary.com/.../watermark/...",
      "thumbUrl": "",
      "originalUrl": "",
      "confidence": 0.95,
      "takenAt": "2025-03-15T10:30:00Z"
    },
    {
      "photoId": "photo-uuid-2",
      "watermarkUrl": "https://res.cloudinary.com/.../watermark/...",
      "thumbUrl": "",
      "originalUrl": "",
      "confidence": 0.88,
      "takenAt": "2025-03-15T09:15:00Z"
    }
  ],
  "meta": {
    "total": 1250,
    "cursor": "eyJwaG90b0lkIjoiNzEyOC..."
  }
}
```

**Examples:**
```bash
# Primeras 20 fotos del evento con watermark
GET /events/13e7b6fb-d59b-49fe-a20f-896a6de47592/search/all-photos/watermark

# Con paginación
GET /events/13e7b6fb-d59b-49fe-a20f-896a6de47592/search/all-photos/watermark?limit=50&cursor=eyJwaG90b0lkIjo...

# Para galería móvil con menos fotos por página
GET /events/13e7b6fb-d59b-49fe-a20f-896a6de47592/search/all-photos/watermark?limit=10
```

**🔍 Key Features:**
- ✅ **Búsqueda directa en BD** - Sin dependencia de organización de Cloudinary
- ✅ **Endpoints específicos por tipo** - Original, watermark, thumbnail
- ✅ **Paginación cursor-based** - Para grandes volúmenes de fotos
- ✅ **Filtrado por status PROCESSED** - Solo fotos completamente procesadas
- ✅ **Ordenado por confianza** - Las mejores detecciones primero
- ✅ **Rate limiting** - 60 requests por minuto
- ✅ **Galería completa del evento** - Navegar todas las fotos con watermark
- ✅ **Deduplicación automática** - Sin fotos repetidas por múltiples dorsales

**Examples:**
```bash
# Buscar todas las fotos del dorsal 1234
GET /events/13e7b6fb-d59b-49fe-a20f-896a6de47592/search/photos?bib=1234

# Solo fotos originales del dorsal 1234
GET /events/13e7b6fb-d59b-49fe-a20f-896a6de47592/search/photos/original?bib=1234

# Solo fotos con marca de agua del dorsal 1234
GET /events/13e7b6fb-d59b-49fe-a20f-896a6de47592/search/photos/watermark?bib=1234

# Solo thumbnails del dorsal 1234
GET /events/13e7b6fb-d59b-49fe-a20f-896a6de47592/search/photos/thumb?bib=1234

# Con paginación
GET /events/13e7b6fb-d59b-49fe-a20f-896a6de47592/search/photos?bib=1234&limit=10&cursor=eyJjb25maWRlbmNlIjowLjk1...
```

### Subscribe to Notifications
```http
POST /search/:eventId/subscribe
```

**Body:**
```json
{
  "bib": "1234",
  "email": "athlete@example.com"
}
```

### Send Photos by Email
```http
POST /search/:eventId/email-photos
```

**Body:**
```json
{
  "bib": "1234",
  "email": "athlete@example.com",
  "selectedPhotos": ["photo-uuid-1", "photo-uuid-2"] // opcional
}
```

### Get Popular Bibs
```http
GET /search/:eventId/popular-bibs?limit=10
```

---

## 📸 Photos Management

### Get Photo Details
```http
GET /photos/:photoId
Authorization: Bearer <token>
```

### Trigger Photo Processing
```http
POST /photos/:photoId/process
Authorization: Bearer <token>
```

### Add Manual Bib Correction
```http
POST /photos/:photoId/bibs
Authorization: Bearer <token>
```

**Body:**
```json
{
  "bib": "1234",
  "confidence": 1.0,
  "bbox": [100, 200, 80, 60] // opcional: [x, y, width, height]
}
```

### Remove Bib
```http
DELETE /photos/:photoId/bibs/:bibId
Authorization: Bearer <token>
```

### Delete Photo
```http
DELETE /photos/:photoId
Authorization: Bearer <token>
```

### Generate Download URL
```http
GET /photos/:photoId/download
Authorization: Bearer <token>
```

---

## 💰 Payments Endpoints

### Create Order
```http
POST /payments/orders
```

**Body:**
```json
{
  "eventId": "event-uuid",
  "items": [
    {
      "type": "PHOTO",
      "photoId": "photo-uuid"
    },
    {
      "type": "PACKAGE", 
      "packageType": "pack5"
    }
  ]
}
```

**Response (Demo Mode):**
```json
{
  "data": {
    "orderId": "order-uuid",
    "totalAmount": 2500,
    "currency": "EUR",
    "status": "PAID",
    "demoMode": true,
    "message": "Pago simulado - Pedido procesado automáticamente"
  }
}
```

### Get User Orders
```http
GET /payments/orders?page=1&limit=20
Authorization: Bearer <token>
```

### Get Download URLs
```http
GET /payments/orders/:orderId/download
```

**Response:**
```json
{
  "data": {
    "orderId": "order-uuid",
    "downloads": [
      {
        "photoId": "photo-uuid",
        "downloadUrl": "https://signed-url...",
        "expiresAt": "2025-03-15T10:35:00Z"
      }
    ],
    "expiresInMinutes": 5
  }
}
```

---

## ⚙️ Admin Endpoints

*Requieren rol ADMIN o ser propietario del evento*

### Get Event Metrics
```http
GET /admin/events/:eventId/metrics
Authorization: Bearer <admin-token>
```

**Response:**
```json
{
  "data": {
    "eventId": "event-uuid",
    "photos": {
      "total": 500,
      "processed": 485,
      "failed": 5,
      "pending": 10,
      "processingRate": 97.0
    },
    "bibs": {
      "total": 1250,
      "unique": 450,
      "avgBibsPerPhoto": 2.6
    },
    "orders": {
      "total": 125,
      "paid": 110,
      "conversionRate": 88.0
    },
    "revenue": {
      "totalCents": 55000,
      "avgOrderValue": 500
    },
    "subscriptions": {
      "total": 80
    },
    "ocr": {
      "accuracy": 94.5
    }
  }
}
```

### Get Top Bibs
```http
GET /admin/events/:eventId/top-bibs?limit=20
Authorization: Bearer <admin-token>
```

### Reprocess Photo
```http
POST /admin/photos/:photoId/reprocess
Authorization: Bearer <admin-token>
```

**Body:**
```json
{
  "strategy": "pro" // "flash" o "pro"
}
```

### Get Queue Stats
```http
GET /admin/queue-stats
Authorization: Bearer <admin-token>
```

**Response:**
```json
{
  "data": {
    "processPhoto": {
      "waiting": 5,
      "active": 2,
      "completed": 1250,
      "failed": 8
    },
    "email": {
      "waiting": 1,
      "active": 0,
      "completed": 340,
      "failed": 2
    }
  }
}
```

### Get System Stats
```http
GET /admin/system-stats
Authorization: Bearer <admin-token>
```

### Get Audit Logs
```http
GET /admin/audit-logs?photoId=uuid&userId=uuid&page=1&limit=50
Authorization: Bearer <admin-token>
```

### Clean Queues
```http
POST /admin/queue/clean
Authorization: Bearer <admin-token>
```

---

## 📋 Response Format

### Success Response
```json
{
  "data": { /* response data */ },
  "meta": { /* pagination, cursors, etc */ }
}
```

### Error Response
```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "Human readable message",
    "details": { /* additional error info */ }
  },
  "timestamp": "2025-03-15T10:30:00Z",
  "path": "/v1/endpoint"
}
```

### Common Error Codes
- `INVALID_CREDENTIALS`: Login failed
- `TOKEN_EXPIRED`: JWT token expired
- `UNAUTHORIZED`: No token provided
- `FORBIDDEN`: Insufficient permissions
- `EVENT_NOT_FOUND`: Event doesn't exist
- `PHOTO_NOT_FOUND`: Photo doesn't exist
- `BIB_NOT_FOUND`: No photos found for bib
- `VALIDATION_ERROR`: Invalid input data
- `RATE_LIMITED`: Too many requests
- `UPLOAD_FAILED`: File upload error
- `PAYMENT_FAILED`: Payment processing error

---

## 🤖 Gemini AI Token Tracking

### OCR Token Usage
La plataforma ahora rastrea automáticamente el uso de tokens de la API de Gemini durante el procesamiento OCR.

**Tokens Tracked:**
- `promptTokens`: Tokens utilizados en la entrada (prompt + imagen)
- `candidatesTokens`: Tokens utilizados en la respuesta generada
- `totalTokens`: Total de tokens consumidos por la operación

**Storage:**
Los datos de tokens se almacenan en la tabla `photo_bibs` con cada dorsal detectado:

```sql
-- Nuevos campos en photo_bibs
ALTER TABLE photo_bibs ADD COLUMN prompt_tokens INT;
ALTER TABLE photo_bibs ADD COLUMN candidates_tokens INT; 
ALTER TABLE photo_bibs ADD COLUMN total_tokens INT;
```

**Analytics Query Examples:**
```sql
-- Total tokens consumidos por evento
SELECT 
  e.name,
  SUM(pb.total_tokens) as total_tokens,
  COUNT(pb.id) as total_bibs_detected,
  AVG(pb.total_tokens) as avg_tokens_per_detection
FROM photo_bibs pb
JOIN events e ON pb.event_id = e.id
WHERE pb.total_tokens IS NOT NULL
GROUP BY e.id, e.name;

-- Tokens por foto procesada
SELECT 
  p.id,
  COUNT(pb.id) as bibs_detected,
  MAX(pb.total_tokens) as tokens_used,
  pb.created_at
FROM photos p
JOIN photo_bibs pb ON p.id = pb.photo_id
WHERE pb.total_tokens IS NOT NULL
GROUP BY p.id, pb.created_at
ORDER BY pb.created_at DESC;
```

**Cost Estimation:**
- Gemini 2.0 Flash: ~$0.075 per 1M input tokens, ~$0.30 per 1M output tokens
- Gemini 1.5 Pro: ~$1.25 per 1M input tokens, ~$5.00 per 1M output tokens

---

## 🔧 Rate Limits

| Endpoint | Limit |
|----------|-------|
| `/search/photos` | 60 req/min |
| `/search/email-photos` | 5 req/min |
| `/uploads/photo` | 20 req/min |
| `/uploads/photos/batch` | 5 req/min |
| `/payments/orders` | 10 req/min |
| Default | 100 req/min |

---

## 📝 File Upload Constraints

- **Max file size**: 20MB
- **Allowed types**: `image/jpeg`, `image/jpg`, `image/png`
- **Allowed extensions**: `.jpg`, `.jpeg`, `.png`

---

## 🎯 Event Bib Rules

```json
{
  "bibRules": {
    "minLen": 3,           // Mínimo 3 dígitos
    "maxLen": 5,           // Máximo 5 dígitos  
    "range": [1, 9999],    // Rango numérico válido
    "regex": "^[0-9]+$",   // Solo números
    "whitelist": ["1234", "5678"] // Solo estos dorsales (opcional)
  }
}
```

---

## 💰 Pricing Structure

```json
{
  "pricing": {
    "singlePhoto": 500,    // 5.00 EUR (centavos)
    "pack5": 2000,         // 20.00 EUR por 5 fotos
    "pack10": 3500,        // 35.00 EUR por 10 fotos
    "allPhotos": 5000,     // 50.00 EUR todas del dorsal
    "currency": "EUR"      // USD, EUR, etc.
  }
}
```

---

## 🚀 Quick Examples

### Complete Workflow Example

```bash
# 1. Register photographer
curl -X POST http://localhost:8080/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "photographer@example.com",
    "password": "password123",
    "role": "PHOTOGRAPHER"
  }'

# 2. Create event
curl -X POST http://localhost:8080/v1/events \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Test Marathon",
    "date": "2025-06-01",
    "bibRules": {"minLen": 3, "maxLen": 4},
    "pricing": {"singlePhoto": 500, "currency": "EUR"}
  }'

# 3. Upload event cover image (optional)
curl -X POST http://localhost:8080/v1/events/$EVENT_ID/image \
  -H "Authorization: Bearer $TOKEN" \
  -F "image=@event-cover.jpg"

# 4. Upload photo
curl -X POST http://localhost:8080/v1/uploads/photo \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@photo.jpg" \
  -F "eventId=$EVENT_ID"

# 5. View all event photos (dashboard)
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8080/v1/events/$EVENT_ID/photos?status=PROCESSED&page=1&limit=10"

# 6. Browse event photos with watermark (athletes/admins)
curl -H "Authorization: Bearer $ATHLETE_TOKEN" \
  "http://localhost:8080/v1/public/events/$EVENT_ID/photos?page=1&limit=20"

# 7. Search by bib with watermark (athletes/admins)
curl -H "Authorization: Bearer $ATHLETE_TOKEN" \
  "http://localhost:8080/v1/public/events/$EVENT_ID/photos/search?bib=1234"

# 8. Search by bib (public - no watermark, optimized)
curl "http://localhost:8080/v1/search/$EVENT_ID/photos?bib=1234"

# 9. Purchase photo
curl -X POST http://localhost:8080/v1/payments/orders \
  -H "Content-Type: application/json" \
  -d '{
    "eventId": "'$EVENT_ID'",
    "items": [{"type": "PHOTO", "photoId": "'$PHOTO_ID'"}]
  }'

# 10. Download (with order ID from step 9)
curl "http://localhost:8080/v1/payments/orders/$ORDER_ID/download"
```

---

## 🔒 Security Notes

1. **Always use HTTPS** in production
2. **Store JWT tokens securely** (httpOnly cookies recommended)
3. **Refresh tokens before expiry** (15 minutes for access tokens)
4. **Rate limits apply** - handle 429 responses
5. **File uploads are validated** - only images allowed
6. **Download URLs expire** - use them immediately

---

## 📞 Support

Para preguntas sobre la API o reportar bugs:
- 📧 Email: api-support@fotografos.com
- 📋 Issues: https://github.com/fotografos/platform/issues
- 📖 Docs: https://docs.fotografos.com