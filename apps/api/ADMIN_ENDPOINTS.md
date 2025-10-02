# Documentación Completa de Endpoints Administrativos

Esta documentación detalla **TODOS** los endpoints disponibles para administradores de la plataforma.

**Última actualización:** 2025-10-02
**Versión:** 2.0.0

---

## 📋 Tabla de Contenidos

0. [**Autenticación (Login)**](#0-autenticación-login)
1. [**Gestión de Usuarios**](#1-gestión-de-usuarios)
2. [**Gestión de Órdenes**](#2-gestión-de-órdenes)
3. [**Gestión de Eventos**](#3-gestión-de-eventos)
4. [**Gestión de Fotos**](#4-gestión-de-fotos)
5. [**Gestión de Trabajos de Carga (Batch Jobs)**](#5-gestión-de-trabajos-de-carga)
6. [**Gestión de Suscripciones**](#6-gestión-de-suscripciones)
7. [**Sistema y Reportes**](#7-sistema-y-reportes)
8. [**Métricas y Estadísticas (Ya existentes)**](#8-métricas-y-estadísticas)

---

## 0. Autenticación (Login)

### POST `/auth/create-admin`
**Crea el primer usuario administrador** (solo usar en setup inicial).

**⚠️ Protegido con clave secreta**

**Body:**
```json
{
  "email": "admin@example.com",
  "password": "SecurePassword123!",
  "name": "Admin Name",
  "secretKey": "tu-clave-secreta"
}
```

**Respuesta:**
```json
{
  "data": {
    "message": "Usuario administrador creado exitosamente",
    "user": {
      "id": "uuid",
      "email": "admin@example.com",
      "name": "Admin Name",
      "role": "ADMIN"
    }
  }
}
```

---

### POST `/auth/login`
Inicia sesión y obtiene tokens de autenticación.

**Body:**
```json
{
  "email": "admin@fotografo.com",
  "password": "Admin123456!"
}
```

**Respuesta:**
```json
{
  "data": {
    "tokens": {
      "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
      "refreshToken": "a1b2c3d4e5f6..."
    },
    "user": {
      "id": "uuid",
      "email": "admin@fotografo.com",
      "name": "Super Admin",
      "role": "ADMIN",
      "createdAt": "2025-01-01T00:00:00Z"
    }
  }
}
```

---

### POST `/auth/refresh`
Refresca el access token usando el refresh token.

**Body:**
```json
{
  "refreshToken": "a1b2c3d4e5f6..."
}
```

**Respuesta:**
```json
{
  "data": {
    "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
  }
}
```

---

### POST `/auth/logout`
Cierra la sesión e invalida el refresh token.

**Body:**
```json
{
  "refreshToken": "a1b2c3d4e5f6..."
}
```

**Respuesta:** `204 No Content`

---

### GET `/auth/profile`
Obtiene el perfil del usuario autenticado.

**Headers:**
```
Authorization: Bearer {accessToken}
```

**Respuesta:**
```json
{
  "data": {
    "id": "uuid",
    "email": "admin@fotografo.com",
    "name": "Super Admin",
    "phone": null,
    "profileImageUrl": null,
    "address": null,
    "role": "ADMIN",
    "createdAt": "2025-01-01T00:00:00Z"
  }
}
```

---

## 1. Gestión de Usuarios

**Base:** `/admin/users`
**Autenticación:** JWT + Rol `ADMIN`

---

### GET `/admin/users`
Lista todos los usuarios del sistema con filtros y paginación.

**Query Parameters:**
- `page` (number, default: 1)
- `limit` (number, default: 20)
- `role` (string): `ATHLETE`, `PHOTOGRAPHER`, `ADMIN`
- `isVerified` (boolean)
- `isFeatured` (boolean)
- `search` (string) - Busca en email, nombre, slug

**Ejemplo:**
```bash
GET /admin/users?page=1&limit=20&role=PHOTOGRAPHER&search=john
```

**Respuesta:**
```json
{
  "data": [
    {
      "id": "uuid",
      "email": "user@example.com",
      "name": "John Doe",
      "phone": "+1234567890",
      "role": "PHOTOGRAPHER",
      "slug": "john-doe",
      "isVerified": true,
      "isFeatured": false,
      "location": "New York",
      "createdAt": "2025-01-01T00:00:00Z",
      "_count": {
        "ownedEvents": 5,
        "photographedPhotos": 150,
        "orders": 10
      }
    }
  ],
  "meta": {
    "pagination": {
      "page": 1,
      "limit": 20,
      "total": 100,
      "pages": 5
    }
  }
}
```

---

### GET `/admin/users/stats`
Estadísticas globales de usuarios.

**Respuesta:**
```json
{
  "data": {
    "total": 500,
    "byRole": {
      "ATHLETE": 350,
      "PHOTOGRAPHER": 140,
      "ADMIN": 10
    },
    "verified": 120,
    "featured": 25,
    "recentSignups": 45
  }
}
```

---

### GET `/admin/users/:id`
Detalles completos de un usuario.

**Respuesta:**
```json
{
  "data": {
    "id": "uuid",
    "email": "user@example.com",
    "name": "John Doe",
    "phone": "+1234567890",
    "profileImageUrl": "https://...",
    "address": "123 Main St",
    "role": "PHOTOGRAPHER",
    "slug": "john-doe",
    "bio": "Professional photographer...",
    "website": "https://johndoe.com",
    "instagram": "@johndoe",
    "facebook": "johndoe",
    "specialties": ["sports", "events"],
    "experienceYears": 10,
    "location": "New York",
    "portfolioUrl": "https://...",
    "isFeatured": false,
    "isVerified": true,
    "createdAt": "2025-01-01T00:00:00Z",
    "updatedAt": "2025-01-15T00:00:00Z",
    "_count": {
      "ownedEvents": 5,
      "photographedPhotos": 150,
      "orders": 10
    }
  }
}
```

---

### PATCH `/admin/users/:id`
Actualiza cualquier campo de un usuario.

**Body:**
```json
{
  "email": "newemail@example.com",
  "name": "New Name",
  "phone": "+1234567890",
  "role": "PHOTOGRAPHER",
  "isVerified": true,
  "isFeatured": true,
  "slug": "new-slug",
  "bio": "Updated bio...",
  "website": "https://newsite.com",
  "instagram": "@newhandle",
  "facebook": "newhandle",
  "location": "Los Angeles"
}
```

---

### DELETE `/admin/users/:id`
Elimina un usuario (no se puede si tiene eventos/fotos).

**Respuesta:**
```json
{
  "data": {
    "message": "Usuario eliminado correctamente"
  }
}
```

---

### PATCH `/admin/users/:id/verify`
Toggle verificación de usuario.

---

### PATCH `/admin/users/:id/feature`
Toggle destacado de usuario.

---

### POST `/admin/users/:id/reset-password`
Resetea la contraseña de cualquier usuario.

**Body:**
```json
{
  "newPassword": "NewSecurePassword123!"
}
```

---

## 2. Gestión de Órdenes

**Base:** `/admin/orders`
**Autenticación:** JWT + Rol `ADMIN`

---

### GET `/admin/orders`
Lista todas las órdenes del sistema.

**Query Parameters:**
- `page` (number, default: 1)
- `limit` (number, default: 20)
- `status` (string): `CREATED`, `PAID`, `CANCELLED`, `REFUNDED`
- `userId` (string)
- `eventId` (string)
- `dateFrom` (string, ISO date)
- `dateTo` (string, ISO date)

**Ejemplo:**
```bash
GET /admin/orders?status=PAID&dateFrom=2025-01-01&dateTo=2025-01-31
```

**Respuesta:**
```json
{
  "data": [
    {
      "id": "uuid",
      "userId": "uuid",
      "eventId": "uuid",
      "amountCents": 5000,
      "currency": "USD",
      "status": "PAID",
      "stripeSessionId": "cs_test_...",
      "createdAt": "2025-01-15T00:00:00Z",
      "user": {
        "id": "uuid",
        "email": "user@example.com",
        "name": "John Doe"
      },
      "event": {
        "id": "uuid",
        "name": "Maratón NYC 2025",
        "slug": "maraton-nyc-2025"
      },
      "items": [
        {
          "id": "uuid",
          "itemType": "PHOTO",
          "priceCents": 2500,
          "photo": {
            "id": "uuid",
            "thumbUrl": "https://...",
            "watermarkUrl": "https://..."
          }
        }
      ]
    }
  ],
  "meta": {
    "pagination": {
      "page": 1,
      "limit": 20,
      "total": 500,
      "pages": 25
    }
  }
}
```

---

### GET `/admin/orders/stats`
Estadísticas de órdenes.

**Respuesta:**
```json
{
  "data": {
    "total": 3500,
    "byStatus": {
      "CREATED": {
        "count": 150,
        "revenue": 0
      },
      "PAID": {
        "count": 3200,
        "revenue": 16000000
      },
      "CANCELLED": {
        "count": 100,
        "revenue": 0
      },
      "REFUNDED": {
        "count": 50,
        "revenue": -250000
      }
    },
    "totalRevenue": 15750000,
    "avgOrderValue": 5000,
    "recentOrders": 45
  }
}
```

---

### GET `/admin/orders/revenue`
Reporte de ingresos por período.

**Query Parameters:**
- `period` (string): `daily`, `monthly`, `yearly`
- `dateFrom` (string, ISO date)
- `dateTo` (string, ISO date)

**Ejemplo:**
```bash
GET /admin/orders/revenue?period=monthly&dateFrom=2025-01-01&dateTo=2025-12-31
```

**Respuesta:**
```json
{
  "data": [
    {
      "period": "2025-01",
      "revenue": 1500000,
      "orders": 300,
      "avgOrderValue": 5000
    },
    {
      "period": "2025-02",
      "revenue": 1800000,
      "orders": 360,
      "avgOrderValue": 5000
    }
  ]
}
```

---

### GET `/admin/orders/:id`
Detalles completos de una orden.

**Respuesta:**
```json
{
  "data": {
    "id": "uuid",
    "userId": "uuid",
    "eventId": "uuid",
    "amountCents": 5000,
    "currency": "USD",
    "status": "PAID",
    "stripeSessionId": "cs_test_...",
    "createdAt": "2025-01-15T00:00:00Z",
    "user": {
      "id": "uuid",
      "email": "user@example.com",
      "name": "John Doe",
      "phone": "+1234567890"
    },
    "event": {
      "id": "uuid",
      "name": "Maratón NYC 2025",
      "slug": "maraton-nyc-2025",
      "date": "2025-06-15",
      "location": "New York"
    },
    "items": [...]
  }
}
```

---

### PATCH `/admin/orders/:id/status`
Cambia el estado de una orden.

**Body:**
```json
{
  "status": "REFUNDED"
}
```

**Respuesta:**
```json
{
  "data": {
    "id": "uuid",
    "status": "REFUNDED",
    "user": {
      "email": "user@example.com",
      "name": "John Doe"
    }
  }
}
```

---

### DELETE `/admin/orders/:id`
Elimina una orden (solo si está en CREATED o CANCELLED).

---

## 3. Gestión de Eventos

**Base:** `/admin/events`
**Autenticación:** JWT + Rol `ADMIN`

---

### GET `/admin/events`
Lista todos los eventos (incluidos eliminados si se especifica).

**Query Parameters:**
- `page` (number, default: 1)
- `limit` (number, default: 20)
- `ownerId` (string)
- `includeDeleted` (boolean)
- `search` (string) - Busca en nombre, slug, ubicación
- `dateFrom` (string, ISO date)
- `dateTo` (string, ISO date)

**Ejemplo:**
```bash
GET /admin/events?includeDeleted=true&search=marathon
```

**Respuesta:**
```json
{
  "data": [
    {
      "id": "uuid",
      "name": "Maratón NYC 2025",
      "slug": "maraton-nyc-2025",
      "date": "2025-06-15",
      "location": "New York",
      "imageUrl": "https://...",
      "ownerId": "uuid",
      "deletedAt": null,
      "createdAt": "2025-01-01T00:00:00Z",
      "owner": {
        "id": "uuid",
        "email": "photographer@example.com",
        "name": "Pro Photographer",
        "slug": "pro-photographer"
      },
      "_count": {
        "photos": 1500,
        "orders": 250,
        "bibSubscriptions": 85
      }
    }
  ],
  "meta": {
    "pagination": {
      "page": 1,
      "limit": 20,
      "total": 75,
      "pages": 4
    }
  }
}
```

---

### GET `/admin/events/deleted`
Lista solo eventos eliminados (soft delete).

---

### GET `/admin/events/stats`
Estadísticas de eventos.

**Respuesta:**
```json
{
  "data": {
    "total": 75,
    "active": 70,
    "deleted": 5,
    "recent": 12,
    "withOrders": 60
  }
}
```

---

### GET `/admin/events/:id`
Detalles completos de un evento.

**Respuesta:**
```json
{
  "data": {
    "id": "uuid",
    "name": "Maratón NYC 2025",
    "slug": "maraton-nyc-2025",
    "date": "2025-06-15",
    "location": "New York",
    "imageUrl": "https://...",
    "ownerId": "uuid",
    "bibRules": {...},
    "pricing": {...},
    "deletedAt": null,
    "createdAt": "2025-01-01T00:00:00Z",
    "owner": {
      "id": "uuid",
      "email": "photographer@example.com",
      "name": "Pro Photographer",
      "slug": "pro-photographer",
      "phone": "+1234567890"
    },
    "_count": {
      "photos": 1500,
      "photoBibs": 2000,
      "orders": 250,
      "bibSubscriptions": 85
    }
  }
}
```

---

### PATCH `/admin/events/:id`
Actualiza cualquier campo de un evento.

**Body:**
```json
{
  "name": "Nuevo Nombre",
  "location": "Nueva Ubicación",
  "date": "2025-07-15",
  "pricing": {...},
  "bibRules": {...}
}
```

---

### DELETE `/admin/events/:id/permanent`
Elimina permanentemente un evento (hard delete).

**⚠️ PELIGROSO:** Elimina en cascada fotos, dorsales, órdenes, etc.

**Respuesta:**
```json
{
  "data": {
    "message": "Evento eliminado permanentemente",
    "deletedPhotos": 1500,
    "deletedOrders": 250
  }
}
```

---

### PATCH `/admin/events/:id/restore`
Restaura un evento eliminado (soft delete).

---

### POST `/admin/events/:id/reassign`
Reasigna un evento a otro fotógrafo.

**Body:**
```json
{
  "newOwnerId": "uuid-del-nuevo-fotografo"
}
```

**Respuesta:**
```json
{
  "data": {
    "id": "uuid",
    "name": "Maratón NYC 2025",
    "owner": {
      "id": "uuid",
      "email": "newfotografo@example.com",
      "name": "Nuevo Fotógrafo"
    }
  }
}
```

---

## 4. Gestión de Fotos

**Base:** `/admin/photos`
**Autenticación:** JWT + Rol `ADMIN`

---

### GET `/admin/photos`
Lista todas las fotos del sistema.

**Query Parameters:**
- `page` (number, default: 1)
- `limit` (number, default: 50)
- `status` (string): `PENDING`, `PROCESSED`, `FAILED`
- `eventId` (string)
- `photographerId` (string)
- `dateFrom` (string, ISO date)
- `dateTo` (string, ISO date)

**Ejemplo:**
```bash
GET /admin/photos?status=FAILED&eventId=uuid
```

**Respuesta:**
```json
{
  "data": [
    {
      "id": "uuid",
      "eventId": "uuid",
      "photographerId": "uuid",
      "cloudinaryId": "photo123",
      "originalUrl": "https://...",
      "thumbUrl": "https://...",
      "watermarkUrl": "https://...",
      "width": 1920,
      "height": 1080,
      "takenAt": "2025-01-15T10:30:00Z",
      "status": "PROCESSED",
      "createdAt": "2025-01-15T11:00:00Z",
      "event": {
        "id": "uuid",
        "name": "Maratón NYC 2025",
        "slug": "maraton-nyc-2025"
      },
      "photographer": {
        "id": "uuid",
        "email": "photographer@example.com",
        "name": "Pro Photographer"
      },
      "_count": {
        "bibs": 2,
        "faces": 3,
        "orderItems": 5
      }
    }
  ],
  "meta": {
    "pagination": {
      "page": 1,
      "limit": 50,
      "total": 50000,
      "pages": 1000
    }
  }
}
```

---

### GET `/admin/photos/failed`
Lista solo fotos con status FAILED.

---

### GET `/admin/photos/stats`
Estadísticas de fotos.

**Respuesta:**
```json
{
  "data": {
    "total": 50000,
    "byStatus": {
      "PENDING": 500,
      "PROCESSED": 48500,
      "FAILED": 1000
    },
    "recentUploads": 1200,
    "withOrders": 15000
  }
}
```

---

### GET `/admin/photos/:id`
Detalles completos de una foto.

**Respuesta:**
```json
{
  "data": {
    "id": "uuid",
    "eventId": "uuid",
    "photographerId": "uuid",
    "cloudinaryId": "photo123",
    "originalUrl": "https://...",
    "thumbUrl": "https://...",
    "watermarkUrl": "https://...",
    "width": 1920,
    "height": 1080,
    "takenAt": "2025-01-15T10:30:00Z",
    "status": "PROCESSED",
    "createdAt": "2025-01-15T11:00:00Z",
    "event": {...},
    "photographer": {...},
    "bibs": [
      {
        "id": 1,
        "bib": "1234",
        "confidence": 0.95,
        "bbox": {...},
        "source": "GEMINI"
      }
    ],
    "faces": [
      {
        "id": "uuid",
        "confidence": 0.98,
        "age": 35,
        "gender": "male",
        "bbox": {...}
      }
    ],
    "orderItems": [...],
    "auditLogs": [...]
  }
}
```

---

### PATCH `/admin/photos/:id`
Actualiza metadata de una foto.

**Body:**
```json
{
  "status": "PROCESSED",
  "takenAt": "2025-01-15T10:30:00Z"
}
```

---

### POST `/admin/photos/:id/reassign`
Reasigna una foto a otro evento o fotógrafo.

**Body:**
```json
{
  "eventId": "uuid-nuevo-evento",
  "photographerId": "uuid-nuevo-fotografo"
}
```

---

### DELETE `/admin/photos/:id/permanent`
Elimina permanentemente una foto (de Cloudinary y BD).

**⚠️ PELIGROSO:** Acción irreversible.

**Respuesta:**
```json
{
  "data": {
    "message": "Foto eliminada permanentemente",
    "cloudinaryId": "photo123"
  }
}
```

---

### POST `/admin/photos/bulk-delete`
Elimina múltiples fotos a la vez.

**Body:**
```json
{
  "photoIds": ["uuid1", "uuid2", "uuid3", ...]
}
```

**Respuesta:**
```json
{
  "data": {
    "message": "15 fotos eliminadas",
    "deletedCount": 15
  }
}
```

---

## 5. Gestión de Trabajos de Carga

**Base:** `/admin/batch-jobs`
**Autenticación:** JWT + Rol `ADMIN`

---

### GET `/admin/batch-jobs`
Lista todos los trabajos de carga masiva.

**Query Parameters:**
- `page` (number, default: 1)
- `limit` (number, default: 20)
- `status` (string): `PENDING`, `UPLOADING`, `PROCESSING`, `COMPLETED`, `FAILED`
- `ownerId` (string)
- `eventId` (string)
- `dateFrom` (string, ISO date)
- `dateTo` (string, ISO date)

**Respuesta:**
```json
{
  "data": [
    {
      "id": "uuid",
      "status": "COMPLETED",
      "totalFiles": 500,
      "uploadedFiles": 500,
      "processedFiles": 495,
      "watermarkFiles": 495,
      "geminiFiles": 490,
      "faceFiles": 485,
      "failedWatermarks": 5,
      "failedGemini": 5,
      "failedFaces": 10,
      "ownerId": "uuid",
      "eventId": "uuid",
      "createdAt": "2025-01-15T00:00:00Z",
      "updatedAt": "2025-01-15T02:30:00Z",
      "owner": {
        "id": "uuid",
        "email": "photographer@example.com",
        "name": "Pro Photographer"
      },
      "event": {
        "id": "uuid",
        "name": "Maratón NYC 2025",
        "slug": "maraton-nyc-2025"
      },
      "_count": {
        "photos": 495
      }
    }
  ],
  "meta": {
    "pagination": {
      "page": 1,
      "limit": 20,
      "total": 150,
      "pages": 8
    }
  }
}
```

---

### GET `/admin/batch-jobs/stats`
Estadísticas de trabajos de carga.

**Respuesta:**
```json
{
  "data": {
    "total": 150,
    "byStatus": {
      "PENDING": {
        "count": 5,
        "totalFiles": 2500,
        "uploadedFiles": 0,
        "processedFiles": 0
      },
      "COMPLETED": {
        "count": 120,
        "totalFiles": 60000,
        "uploadedFiles": 60000,
        "processedFiles": 58500
      },
      "FAILED": {
        "count": 10,
        "totalFiles": 5000,
        "uploadedFiles": 2000,
        "processedFiles": 1500
      }
    },
    "recentJobs": 15,
    "totalFilesProcessed": 58500,
    "totalFilesUploaded": 62000
  }
}
```

---

### GET `/admin/batch-jobs/:id`
Detalles completos de un trabajo.

**Respuesta:**
```json
{
  "data": {
    "id": "uuid",
    "status": "COMPLETED",
    "totalFiles": 500,
    "uploadedFiles": 500,
    "processedFiles": 495,
    "watermarkFiles": 495,
    "geminiFiles": 490,
    "faceFiles": 485,
    "failedWatermarks": 5,
    "failedGemini": 5,
    "failedFaces": 10,
    "ownerId": "uuid",
    "eventId": "uuid",
    "createdAt": "2025-01-15T00:00:00Z",
    "updatedAt": "2025-01-15T02:30:00Z",
    "owner": {...},
    "event": {...},
    "photos": [
      {
        "id": "uuid",
        "status": "PROCESSED",
        "thumbUrl": "https://...",
        "createdAt": "2025-01-15T00:05:00Z"
      }
    ],
    "_count": {
      "photos": 495
    }
  }
}
```

---

### POST `/admin/batch-jobs/:id/retry`
Reinicia un trabajo fallido.

**Respuesta:**
```json
{
  "data": {
    "id": "uuid",
    "status": "PENDING",
    "totalFiles": 500,
    "uploadedFiles": 0,
    "processedFiles": 0
  }
}
```

---

### POST `/admin/batch-jobs/:id/cancel`
Cancela un trabajo en progreso.

---

### DELETE `/admin/batch-jobs/:id`
Elimina un trabajo de carga.

**Respuesta:**
```json
{
  "data": {
    "message": "Trabajo eliminado correctamente",
    "photosCount": 495
  }
}
```

---

## 6. Gestión de Suscripciones

**Base:** `/admin/subscriptions`
**Autenticación:** JWT + Rol `ADMIN`

---

### GET `/admin/subscriptions`
Lista todas las suscripciones de dorsales.

**Query Parameters:**
- `page` (number, default: 1)
- `limit` (number, default: 50)
- `eventId` (string)
- `email` (string)
- `bib` (string)
- `dateFrom` (string, ISO date)
- `dateTo` (string, ISO date)

**Respuesta:**
```json
{
  "data": [
    {
      "id": "uuid",
      "eventId": "uuid",
      "bib": "1234",
      "email": "athlete@example.com",
      "createdAt": "2025-01-10T00:00:00Z",
      "event": {
        "id": "uuid",
        "name": "Maratón NYC 2025",
        "slug": "maraton-nyc-2025",
        "date": "2025-06-15"
      }
    }
  ],
  "meta": {
    "pagination": {
      "page": 1,
      "limit": 50,
      "total": 850,
      "pages": 17
    }
  }
}
```

---

### GET `/admin/subscriptions/stats`
Estadísticas de suscripciones.

**Respuesta:**
```json
{
  "data": {
    "total": 850,
    "recent": 120,
    "uniqueEmails": 650,
    "topEvents": [
      {
        "eventId": "uuid",
        "eventName": "Maratón NYC 2025",
        "eventSlug": "maraton-nyc-2025",
        "count": 200
      },
      {
        "eventId": "uuid",
        "eventName": "Ironman Barcelona",
        "eventSlug": "ironman-barcelona",
        "count": 150
      }
    ]
  }
}
```

---

### GET `/admin/subscriptions/event/:eventId`
Suscripciones de un evento específico.

---

### GET `/admin/subscriptions/:id`
Detalles de una suscripción.

---

### DELETE `/admin/subscriptions/:id`
Elimina una suscripción.

---

### POST `/admin/subscriptions/bulk-delete`
Elimina múltiples suscripciones.

**Body:**
```json
{
  "subscriptionIds": ["uuid1", "uuid2", "uuid3"]
}
```

**Respuesta:**
```json
{
  "data": {
    "message": "15 suscripciones eliminadas",
    "deletedCount": 15
  }
}
```

---

## 7. Sistema y Reportes

**Base:** `/admin/system`
**Autenticación:** JWT + Rol `ADMIN`

---

### GET `/admin/system/health`
Health check del sistema.

**Respuesta:**
```json
{
  "data": {
    "status": "healthy",
    "timestamp": "2025-01-20T15:30:00Z",
    "checks": {
      "database": {
        "ok": true,
        "message": "Database connected"
      },
      "queues": {
        "ok": true,
        "processPhoto": {
          "waiting": 45,
          "active": 5
        },
        "email": {
          "waiting": 8,
          "active": 2
        }
      }
    }
  }
}
```

---

### GET `/admin/system/reports/daily`
Reporte de actividad diaria.

**Query Parameters:**
- `date` (string, ISO date, opcional) - Si no se especifica, usa hoy

**Ejemplo:**
```bash
GET /admin/system/reports/daily?date=2025-01-15
```

**Respuesta:**
```json
{
  "data": {
    "date": "2025-01-15",
    "users": {
      "new": 25
    },
    "events": {
      "new": 3
    },
    "photos": {
      "uploaded": 1500,
      "processed": 1450
    },
    "orders": {
      "new": 120
    },
    "revenue": {
      "totalCents": 600000
    },
    "subscriptions": {
      "new": 35
    }
  }
}
```

---

### GET `/admin/system/reports/monthly`
Reporte de actividad mensual.

**Query Parameters:**
- `year` (number, default: año actual)
- `month` (number, default: mes actual)

**Ejemplo:**
```bash
GET /admin/system/reports/monthly?year=2025&month=1
```

**Respuesta:**
```json
{
  "data": {
    "period": "2025-01",
    "users": {
      "new": 450
    },
    "events": {
      "new": 25
    },
    "photos": {
      "uploaded": 35000,
      "processed": 33500,
      "processingRate": 95.71
    },
    "orders": {
      "total": 2500,
      "paid": 2400,
      "conversionRate": 96.0
    },
    "revenue": {
      "totalCents": 12000000,
      "avgOrderValue": 5000
    },
    "subscriptions": {
      "new": 650
    }
  }
}
```

---

### GET `/admin/system/reports/users-growth`
Crecimiento de usuarios por mes.

**Query Parameters:**
- `months` (number, default: 12)

**Respuesta:**
```json
{
  "data": [
    {
      "period": "2024-02",
      "newUsers": 150,
      "totalUsers": 500
    },
    {
      "period": "2024-03",
      "newUsers": 200,
      "totalUsers": 700
    },
    {
      "period": "2024-04",
      "newUsers": 250,
      "totalUsers": 950
    }
  ]
}
```

---

### GET `/admin/system/reports/events-performance`
Performance de eventos ordenados por ingresos.

**Query Parameters:**
- `limit` (number, default: 20)

**Respuesta:**
```json
{
  "data": [
    {
      "id": "uuid",
      "name": "Maratón NYC 2025",
      "slug": "maraton-nyc-2025",
      "date": "2025-06-15",
      "owner": {
        "name": "Pro Photographer",
        "email": "pro@example.com"
      },
      "stats": {
        "totalPhotos": 1500,
        "processedPhotos": 1450,
        "orders": 250,
        "subscriptions": 85,
        "revenueCents": 1250000
      }
    }
  ]
}
```

---

### POST `/admin/system/cleanup/audit-logs`
Limpia logs de auditoría antiguos.

**Query Parameters:**
- `daysToKeep` (number, default: 90)

**Respuesta:**
```json
{
  "data": {
    "message": "Logs antiguos eliminados",
    "deletedCount": 15000,
    "cutoffDate": "2024-10-22T00:00:00Z"
  }
}
```

---

## 8. Métricas y Estadísticas

**Base:** `/admin`
**Autenticación:** JWT + Rol `ADMIN` (algunos endpoints permiten `PHOTOGRAPHER`)

---

### GET `/admin/events/:eventId/metrics`
Métricas completas de un evento.

**Roles permitidos:** `PHOTOGRAPHER` (solo sus eventos), `ADMIN` (todos)

**Respuesta:**
```json
{
  "data": {
    "eventId": "uuid",
    "photos": {
      "total": 1000,
      "processed": 950,
      "failed": 10,
      "pending": 40,
      "processingRate": 95.0
    },
    "bibs": {
      "total": 1200,
      "unique": 350,
      "avgBibsPerPhoto": 1.26
    },
    "orders": {
      "total": 120,
      "paid": 115,
      "conversionRate": 95.83
    },
    "revenue": {
      "totalCents": 5750000,
      "avgOrderValue": 50000
    },
    "subscriptions": {
      "total": 85
    },
    "ocr": {
      "accuracy": 92.5
    }
  }
}
```

---

### GET `/admin/events/:eventId/top-bibs`
Dorsales más fotografiados de un evento.

**Roles permitidos:** `PHOTOGRAPHER`, `ADMIN`

**Query Parameters:**
- `limit` (number, default: 20)

**Respuesta:**
```json
{
  "data": [
    {
      "bib": "1234",
      "photoCount": 15,
      "avgConfidence": 0.95,
      "orders": 3
    }
  ]
}
```

---

### POST `/admin/photos/:photoId/reprocess`
Reprocesa una foto (vuelve a ejecutar OCR).

**Roles permitidos:** `ADMIN` únicamente

**Body:**
```json
{
  "strategy": "pro"
}
```

**Valores:** `flash`, `pro`

**Respuesta:**
```json
{
  "data": {
    "message": "Reprocesamiento iniciado",
    "strategy": "pro"
  }
}
```

---

### GET `/admin/queue-stats`
Estadísticas de las colas de procesamiento.

**Respuesta:**
```json
{
  "data": {
    "processPhoto": {
      "waiting": 45,
      "active": 5,
      "completed": 1250,
      "failed": 12
    },
    "email": {
      "waiting": 8,
      "active": 2,
      "completed": 450,
      "failed": 3
    }
  }
}
```

---

### GET `/admin/system-stats`
Estadísticas globales del sistema.

**Respuesta:**
```json
{
  "data": {
    "users": {
      "total": 500
    },
    "events": {
      "total": 75
    },
    "photos": {
      "total": 50000,
      "recentUploads": 1200
    },
    "orders": {
      "total": 3500
    },
    "revenue": {
      "totalCents": 17500000
    }
  }
}
```

---

### GET `/admin/audit-logs`
Registro de auditoría del sistema.

**Query Parameters:**
- `photoId` (string, opcional)
- `userId` (string, opcional)
- `page` (number, default: 1)
- `limit` (number, default: 50)

**Respuesta:**
```json
{
  "data": [
    {
      "id": 123,
      "userId": "uuid",
      "photoId": "uuid",
      "action": "REPROCESS_TRIGGERED",
      "data": {
        "strategy": "pro"
      },
      "createdAt": "2025-01-20T00:00:00Z",
      "user": {
        "email": "admin@example.com",
        "role": "ADMIN"
      },
      "photo": {
        "eventId": "uuid"
      }
    }
  ],
  "meta": {
    "pagination": {
      "page": 1,
      "limit": 50,
      "total": 1500,
      "pages": 30
    }
  }
}
```

---

### POST `/admin/queue/clean`
Limpia trabajos completados/fallidos de más de 1 hora.

**Respuesta:**
```json
{
  "data": {
    "message": "Colas limpiadas exitosamente"
  }
}
```

---

## 📊 Resumen de Endpoints

### Por Módulo:

| Módulo | Endpoints | Descripción |
|--------|-----------|-------------|
| **Autenticación** | 5 | Login, registro admin, refresh, logout, perfil |
| **Usuarios** | 8 | CRUD completo + verificación + destacados + reset password |
| **Órdenes** | 6 | Listado, stats, reportes, cambio de estado |
| **Eventos** | 8 | CRUD completo + eliminados + reasignación |
| **Fotos** | 8 | CRUD completo + reasignación + bulk delete |
| **Batch Jobs** | 6 | Listado, stats, retry, cancel |
| **Suscripciones** | 6 | CRUD completo + stats + bulk delete |
| **Sistema** | 6 | Health, reportes diarios/mensuales, growth, performance |
| **Métricas** | 7 | Stats de eventos, colas, sistema, audit logs |
| **TOTAL** | **60+** | **Endpoints administrativos completos** |

---

## 🔐 Autenticación

Todos los endpoints (excepto login/registro) requieren:

**Header:**
```
Authorization: Bearer {accessToken}
```

**Obtener token:**
```bash
curl -X POST http://localhost:3000/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "admin@fotografo.com",
    "password": "Admin123456!"
  }'
```

---

## ⚠️ Códigos de Error

| Código | Descripción |
|--------|-------------|
| `USER_NOT_FOUND` | Usuario no encontrado |
| `USER_ALREADY_EXISTS` | Email ya registrado |
| `SLUG_ALREADY_EXISTS` | Slug ya en uso |
| `USER_HAS_DEPENDENCIES` | Usuario tiene eventos/fotos |
| `FORBIDDEN` | Sin permisos suficientes |
| `EVENT_NOT_FOUND` | Evento no encontrado |
| `PHOTO_NOT_FOUND` | Foto no encontrada |
| `ORDER_NOT_FOUND` | Orden no encontrada |
| `BATCH_JOB_NOT_FOUND` | Trabajo no encontrado |
| `SUBSCRIPTION_NOT_FOUND` | Suscripción no encontrada |
| `CANNOT_DELETE_ORDER` | Orden no se puede eliminar |
| `INVALID_CREDENTIALS` | Credenciales inválidas |
| `TOKEN_EXPIRED` | Token expirado |

---

## 🛡️ Seguridad

1. ✅ Autenticación JWT obligatoria
2. ✅ Validación de rol `ADMIN` en cada endpoint
3. ✅ Contraseñas hasheadas con Argon2
4. ✅ Audit logs automáticos
5. ✅ Validación de permisos por recurso
6. ✅ Rate limiting en endpoints sensibles
7. ✅ CORS configurado
8. ✅ Helmet para headers de seguridad

---

## 📝 Ejemplos de Uso

### Flujo completo de admin:

```bash
# 1. Login
curl -X POST http://localhost:3000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@fotografo.com","password":"Admin123456!"}'

# 2. Listar usuarios
curl -X GET "http://localhost:3000/admin/users?page=1&limit=20" \
  -H "Authorization: Bearer {token}"

# 3. Ver estadísticas del sistema
curl -X GET http://localhost:3000/admin/system-stats \
  -H "Authorization: Bearer {token}"

# 4. Ver reporte mensual
curl -X GET "http://localhost:3000/admin/system/reports/monthly?year=2025&month=1" \
  -H "Authorization: Bearer {token}"

# 5. Cambiar contraseña de un usuario
curl -X POST http://localhost:3000/admin/users/{userId}/reset-password \
  -H "Authorization: Bearer {token}" \
  -H "Content-Type: application/json" \
  -d '{"newPassword":"NewPassword123!"}'
```

---

**Última actualización:** 2025-10-02
**Versión:** 2.0.0
**Creado por:** Claude Code Assistant
