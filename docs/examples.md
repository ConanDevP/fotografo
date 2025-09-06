# 📝 Ejemplos de Uso - Fotografos Platform

Esta guía contiene ejemplos prácticos de cómo usar la API para los casos de uso más comunes.

---

## 🏃‍♂️ Ejemplo Completo: Maratón Local

### **Paso 1: Setup del Evento (Fotógrafo)**

```bash
# 1. Registrar fotógrafo
curl -X POST http://localhost:8080/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "fotografo@maraton.com",
    "password": "password123",
    "role": "PHOTOGRAPHER"
  }'
```

**Response:**
```json
{
  "data": {
    "tokens": {
      "accessToken": "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...",
      "refreshToken": "a1b2c3d4..."
    },
    "user": {
      "id": "photographer-uuid",
      "email": "fotografo@maraton.com",
      "role": "PHOTOGRAPHER"
    }
  }
}
```

```bash
# 2. Crear evento del maratón
TOKEN="eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9..."

curl -X POST http://localhost:8080/v1/events \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Maratón Valencia 2025",
    "date": "2025-04-13",
    "location": "Valencia, España",
    "bibRules": {
      "minLen": 3,
      "maxLen": 5,
      "range": [1, 15000],
      "regex": "^[0-9]+$"
    },
    "pricing": {
      "singlePhoto": 350,
      "pack5": 1500,
      "pack10": 2500,
      "allPhotos": 4000,
      "currency": "EUR"
    }
  }'
```

**Response:**
```json
{
  "data": {
    "id": "event-uuid-123",
    "name": "Maratón Valencia 2025",
    "slug": "maraton-valencia-2025",
    "date": "2025-04-13",
    "bibRules": {
      "minLen": 3,
      "maxLen": 5,
      "range": [1, 15000]
    },
    "pricing": {
      "singlePhoto": 350,
      "pack5": 1500,
      "allPhotos": 4000,
      "currency": "EUR"
    }
  }
}
```

### **Paso 2: Upload Masivo de Fotos**

```bash
# Upload individual
EVENT_ID="event-uuid-123"

curl -X POST http://localhost:8080/v1/uploads/photo \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@/Users/fotografo/fotos/maraton_001.jpg" \
  -F "eventId=$EVENT_ID" \
  -F "takenAt=2025-04-13T09:15:00Z"
```

```bash
# Upload por lotes (recomendado)
curl -X POST http://localhost:8080/v1/uploads/photos/batch \
  -H "Authorization: Bearer $TOKEN" \
  -F "files=@foto_001.jpg" \
  -F "files=@foto_002.jpg" \
  -F "files=@foto_003.jpg" \
  -F "files=@foto_004.jpg" \
  -F "files=@foto_005.jpg" \
  -F "eventId=$EVENT_ID"
```

**Response:**
```json
{
  "data": {
    "successful": [
      {
        "photoId": "photo-uuid-1",
        "cloudinaryId": "events/event-123/original/photo-1",
        "originalUrl": "https://res.cloudinary.com/...",
        "width": 4000,
        "height": 3000
      },
      {
        "photoId": "photo-uuid-2",
        "cloudinaryId": "events/event-123/original/photo-2",
        "originalUrl": "https://res.cloudinary.com/...",
        "width": 4000,
        "height": 3000
      }
    ],
    "errors": [],
    "total": 5,
    "successCount": 5,
    "errorCount": 0
  }
}
```

### **Paso 3: Monitorear Procesamiento (Fotógrafo)**

```bash
# Ver métricas del evento
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:8080/v1/admin/events/$EVENT_ID/metrics
```

**Response:**
```json
{
  "data": {
    "photos": {
      "total": 250,
      "processed": 245,
      "failed": 2,
      "pending": 3,
      "processingRate": 98.0
    },
    "bibs": {
      "total": 580,
      "unique": 240,
      "avgBibsPerPhoto": 2.4
    },
    "ocr": {
      "accuracy": 96.5
    }
  }
}
```

```bash
# Ver dorsales más populares
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8080/v1/admin/events/$EVENT_ID/top-bibs?limit=10"
```

### **Paso 4: Búsqueda por Atleta**

```bash
# Atleta busca sus fotos por dorsal
curl "http://localhost:8080/v1/events/$EVENT_ID/search/photos?bib=1234"
```

**Response:**
```json
{
  "data": [
    {
      "photoId": "photo-uuid-1",
      "thumbUrl": "https://res.cloudinary.com/.../thumb/dorsal-1234/photo-1.jpg",
      "watermarkUrl": "https://res.cloudinary.com/.../wm/dorsal-1234/photo-1.jpg",
      "confidence": 0.97,
      "takenAt": "2025-04-13T09:15:00Z"
    },
    {
      "photoId": "photo-uuid-2", 
      "thumbUrl": "https://res.cloudinary.com/.../thumb/dorsal-1234/photo-2.jpg",
      "watermarkUrl": "https://res.cloudinary.com/.../wm/dorsal-1234/photo-2.jpg",
      "confidence": 0.92,
      "takenAt": "2025-04-13T10:22:00Z"
    }
  ],
  "meta": {
    "total": 6,
    "optimized": true
  }
}
```

### **Paso 5: Compra de Fotos (Atleta)**

```bash
# Comprar foto individual
curl -X POST http://localhost:8080/v1/payments/orders \
  -H "Content-Type: application/json" \
  -d '{
    "eventId": "'$EVENT_ID'",
    "items": [
      {
        "type": "PHOTO",
        "photoId": "photo-uuid-1"
      }
    ]
  }'
```

**Response (Demo Mode):**
```json
{
  "data": {
    "orderId": "order-uuid-123",
    "totalAmount": 350,
    "currency": "EUR",
    "status": "PAID",
    "demoMode": true,
    "message": "Pago simulado - Pedido procesado automáticamente"
  }
}
```

```bash
# Comprar pack de 5 fotos
curl -X POST http://localhost:8080/v1/payments/orders \
  -H "Content-Type: application/json" \
  -d '{
    "eventId": "'$EVENT_ID'",
    "items": [
      {
        "type": "PACKAGE",
        "packageType": "pack5"
      }
    ]
  }'
```

### **Paso 6: Descarga de Fotos Compradas**

```bash
# Obtener URLs de descarga
ORDER_ID="order-uuid-123"
curl "http://localhost:8080/v1/payments/orders/$ORDER_ID/download"
```

**Response:**
```json
{
  "data": {
    "orderId": "order-uuid-123",
    "downloads": [
      {
        "photoId": "photo-uuid-1",
        "downloadUrl": "https://signed-cloudinary-url-expires-in-5-min",
        "expiresAt": "2025-04-13T15:35:00Z"
      }
    ],
    "expiresInMinutes": 5
  }
}
```

```bash
# Descargar foto (usar URL del response anterior)
curl "https://signed-cloudinary-url..." \
  --output "mi_foto_maraton.jpg"
```

---

## 🚴‍♂️ Ejemplo: Ciclismo con Dorsales Especiales

### **Setup para Evento de Ciclismo**

```bash
curl -X POST http://localhost:8080/v1/events \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Vuelta Ciclista Local 2025",
    "date": "2025-05-15",
    "location": "Montaña Central",
    "bibRules": {
      "minLen": 2,
      "maxLen": 3,
      "range": [1, 200],
      "whitelist": ["001", "002", "010", "025", "050", "100"]
    },
    "pricing": {
      "singlePhoto": 400,
      "pack5": 1800,
      "allPhotos": 3000,
      "currency": "EUR"
    }
  }'
```

---

## 📧 Ejemplo: Sistema de Notificaciones

### **Suscripción a Notificaciones**

```bash
# Atleta se suscribe para recibir emails
curl -X POST http://localhost:8080/v1/events/$EVENT_ID/search/subscribe \
  -H "Content-Type: application/json" \
  -d '{
    "bib": "1234",
    "email": "atleta@email.com"
  }'
```

**Response:**
```json
{
  "data": {
    "message": "Suscripción creada correctamente"
  }
}
```

### **Envío Manual de Fotos por Email**

```bash
# Enviar fotos específicas por email
curl -X POST http://localhost:8080/v1/events/$EVENT_ID/search/email-photos \
  -H "Content-Type: application/json" \
  -d '{
    "bib": "1234",
    "email": "atleta@email.com",
    "selectedPhotos": ["photo-uuid-1", "photo-uuid-2"]
  }'
```

---

## ⚙️ Ejemplo: Administración Avanzada

### **Reprocesar Foto con OCR Pro**

```bash
# Reprocesar foto con modelo pro de Gemini
curl -X POST http://localhost:8080/v1/admin/photos/photo-uuid-1/reprocess \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "strategy": "pro"
  }'
```

### **Corrección Manual de Dorsales**

```bash
# Corregir dorsal detectado incorrectamente
curl -X POST http://localhost:8080/v1/photos/photo-uuid-1/bibs \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "bib": "1234",
    "confidence": 1.0,
    "bbox": [150, 200, 80, 60]
  }'
```

### **Estadísticas del Sistema**

```bash
# Ver estadísticas globales (solo admin)
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  http://localhost:8080/v1/admin/system-stats
```

**Response:**
```json
{
  "data": {
    "users": { "total": 156 },
    "events": { "total": 23 },
    "photos": { 
      "total": 12500,
      "recentUploads": 45
    },
    "orders": { "total": 340 },
    "revenue": { "totalCents": 125000 }
  }
}
```

---

## 🛠️ Ejemplo: Scripts de Automatización

### **Script de Upload Masivo**

```bash
#!/bin/bash
# upload_event_photos.sh

TOKEN="your-jwt-token-here"
EVENT_ID="event-uuid-here"
PHOTOS_DIR="/path/to/photos"

echo "Subiendo fotos desde $PHOTOS_DIR..."

# Buscar todas las fotos en el directorio
for photo in $PHOTOS_DIR/*.{jpg,jpeg,png,JPG,JPEG,PNG}; do
  if [ -f "$photo" ]; then
    echo "Subiendo: $(basename "$photo")"
    
    curl -X POST http://localhost:8080/v1/uploads/photo \
      -H "Authorization: Bearer $TOKEN" \
      -F "file=@$photo" \
      -F "eventId=$EVENT_ID" \
      --silent --output /dev/null
    
    echo "✓ Subida completa"
    sleep 2  # Respetar rate limits
  fi
done

echo "🎉 Todas las fotos subidas!"
```

### **Script de Monitoreo**

```bash
#!/bin/bash
# monitor_processing.sh

TOKEN="your-jwt-token-here"
EVENT_ID="event-uuid-here"

while true; do
  echo "=== Métricas del Evento $(date) ==="
  
  curl -s -H "Authorization: Bearer $TOKEN" \
    "http://localhost:8080/v1/admin/events/$EVENT_ID/metrics" | \
    jq '.data | {
      fotos: .photos,
      dorsales: .bibs,
      ocr_accuracy: .ocr.accuracy
    }'
  
  echo ""
  sleep 30
done
```

### **Script de Backup de Órdenes**

```bash
#!/bin/bash
# backup_orders.sh

TOKEN="your-jwt-token-here"
BACKUP_DIR="./backups/$(date +%Y%m%d)"

mkdir -p $BACKUP_DIR

echo "Descargando órdenes pagadas..."

curl -s -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8080/v1/payments/orders?limit=100" | \
  jq '.data' > "$BACKUP_DIR/orders.json"

echo "✓ Backup guardado en $BACKUP_DIR/orders.json"
```

---

## 📱 Ejemplo: Integración Frontend

### **React Hook para Búsqueda**

```javascript
// hooks/usePhotoSearch.js
import { useState, useEffect } from 'react';

export const usePhotoSearch = (eventId, bib) => {
  const [photos, setPhotos] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!eventId || !bib) return;

    const searchPhotos = async () => {
      setLoading(true);
      setError(null);

      try {
        const response = await fetch(
          `/v1/events/${eventId}/search/photos?bib=${bib}`
        );
        
        if (!response.ok) {
          throw new Error('Error en la búsqueda');
        }

        const data = await response.json();
        setPhotos(data.data);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };

    searchPhotos();
  }, [eventId, bib]);

  return { photos, loading, error };
};
```

### **Componente de Búsqueda**

```javascript
// components/BibSearch.jsx
import React, { useState } from 'react';
import { usePhotoSearch } from '../hooks/usePhotoSearch';

const BibSearch = ({ eventId }) => {
  const [bib, setBib] = useState('');
  const { photos, loading, error } = usePhotoSearch(eventId, bib);

  return (
    <div className="bib-search">
      <div className="search-input">
        <input
          type="text"
          placeholder="Ingresa tu número de dorsal"
          value={bib}
          onChange={(e) => setBib(e.target.value)}
        />
      </div>

      {loading && <p>Buscando fotos...</p>}
      {error && <p className="error">Error: {error}</p>}

      <div className="photos-grid">
        {photos.map((photo) => (
          <div key={photo.photoId} className="photo-card">
            <img 
              src={photo.watermarkUrl} 
              alt={`Foto dorsal ${bib}`}
            />
            <div className="photo-info">
              <span>Confianza: {Math.round(photo.confidence * 100)}%</span>
              <span>Fecha: {new Date(photo.takenAt).toLocaleString()}</span>
            </div>
            <button onClick={() => purchasePhoto(photo.photoId)}>
              Comprar €3.50
            </button>
          </div>
        ))}
      </div>
    </div>
  );
};
```

---

## 🔧 Ejemplo: Testing

### **Test de Integración con Jest**

```javascript
// tests/integration/photo-workflow.test.js
const request = require('supertest');
const app = require('../../src/app');

describe('Photo Workflow Integration', () => {
  let photographerToken;
  let eventId;
  let photoId;

  beforeAll(async () => {
    // Register photographer
    const authResponse = await request(app)
      .post('/v1/auth/register')
      .send({
        email: 'test@photographer.com',
        password: 'password123',
        role: 'PHOTOGRAPHER'
      });

    photographerToken = authResponse.body.data.tokens.accessToken;
  });

  test('Complete photo workflow', async () => {
    // 1. Create event
    const eventResponse = await request(app)
      .post('/v1/events')
      .set('Authorization', `Bearer ${photographerToken}`)
      .send({
        name: 'Test Marathon',
        date: '2025-06-01',
        bibRules: { minLen: 3, maxLen: 4 },
        pricing: { singlePhoto: 500, currency: 'EUR' }
      });

    expect(eventResponse.status).toBe(201);
    eventId = eventResponse.body.data.id;

    // 2. Upload photo
    const uploadResponse = await request(app)
      .post('/v1/uploads/photo')
      .set('Authorization', `Bearer ${photographerToken}`)
      .attach('file', './test-assets/sample-bib-photo.jpg')
      .field('eventId', eventId);

    expect(uploadResponse.status).toBe(201);
    photoId = uploadResponse.body.data.photoId;

    // 3. Wait for processing (in real test, use polling)
    await new Promise(resolve => setTimeout(resolve, 5000));

    // 4. Search by bib
    const searchResponse = await request(app)
      .get(`/v1/events/${eventId}/search/photos?bib=1234`);

    expect(searchResponse.status).toBe(200);
    expect(searchResponse.body.data.length).toBeGreaterThan(0);

    // 5. Purchase photo
    const orderResponse = await request(app)
      .post('/v1/payments/orders')
      .send({
        eventId,
        items: [{ type: 'PHOTO', photoId }]
      });

    expect(orderResponse.status).toBe(201);
    expect(orderResponse.body.data.status).toBe('PAID'); // Demo mode

    // 6. Download
    const orderId = orderResponse.body.data.orderId;
    const downloadResponse = await request(app)
      .get(`/v1/payments/orders/${orderId}/download`);

    expect(downloadResponse.status).toBe(200);
    expect(downloadResponse.body.data.downloads).toBeDefined();
  });
});
```

---

## 🎯 Casos de Uso Específicos

### **Evento con Miles de Fotos**

```bash
# Para eventos grandes, usar upload por lotes
# Dividir fotos en grupos de 20-50 por request

for batch in /photos/batch_*; do
  echo "Procesando lote: $batch"
  
  # Construir comando con todas las fotos del lote
  cmd="curl -X POST http://localhost:8080/v1/uploads/photos/batch \
       -H 'Authorization: Bearer $TOKEN'"
  
  for photo in $batch/*.jpg; do
    cmd="$cmd -F 'files=@$photo'"
  done
  
  cmd="$cmd -F 'eventId=$EVENT_ID'"
  
  # Ejecutar upload
  eval $cmd
  
  echo "Lote completado, esperando..."
  sleep 10
done
```

### **Monitoreo en Tiempo Real**

```javascript
// websocket-monitor.js (conceptual)
const ws = new WebSocket('ws://localhost:8080/v1/admin/monitor');

ws.on('message', (data) => {
  const metrics = JSON.parse(data);
  
  console.log(`Fotos procesadas: ${metrics.processed}/${metrics.total}`);
  console.log(`Precisión OCR: ${metrics.ocrAccuracy}%`);
  console.log(`Colas activas: ${metrics.queueStats.active}`);
});
```

Estos ejemplos cubren los casos de uso más comunes. Para casos específicos o integraciones personalizadas, consulta la [documentación completa de la API](./api-documentation.md).