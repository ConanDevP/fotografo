# 🤖 Face Recognition System Documentation

## Overview

The Face Recognition system enables users to search for photos by uploading their own photo (selfie). The system uses Face-API.js to detect faces and create mathematical fingerprints (embeddings) that can be compared for similarity.

## Architecture

### 1. Processing Pipeline

```
Photo Upload → OCR Processing (Bibs) → Face Processing (Parallel)
                     ↓                        ↓
              Save bib detections      Save face embeddings
                     ↓                        ↓
              Search by bib number    Search by user photo
```

### 2. Database Schema

#### FaceEmbedding Table
```sql
CREATE TABLE face_embeddings (
  id UUID PRIMARY KEY,
  photo_id UUID REFERENCES photos(id),
  event_id UUID REFERENCES events(id), 
  embedding DECIMAL(10,8)[], -- 128-dimensional vector
  confidence DECIMAL(4,3),    -- Detection confidence (0-1)
  bounding_box JSON,          -- Face coordinates [x,y,w,h]
  landmarks JSON,             -- Facial feature points
  estimated_age INTEGER,      -- Estimated age
  estimated_gender VARCHAR,   -- Estimated gender
  created_at TIMESTAMP
);
```

## API Endpoints

### 1. Face Search
```http
POST /events/:eventId/search/photos/by-face
Content-Type: application/json

{
  "userImageBase64": "data:image/jpeg;base64,/9j/4AAQ...",
  "threshold": 0.6
}
```

**Response:**
```json
{
  "data": {
    "matches": [
      {
        "photoId": "uuid-123",
        "similarity": 0.87,
        "confidence": 0.95,
        "faceId": "uuid-456",
        "bbox": [100, 200, 80, 100],
        "thumbUrl": "https://cloudinary.com/thumb.jpg",
        "watermarkUrl": "https://cloudinary.com/watermark.jpg"
      }
    ],
    "userFaceDetected": true
  },
  "meta": {
    "total": 15,
    "searchTime": 234
  }
}
```

### 2. Face Statistics
```http
GET /events/:eventId/search/face-stats
```

**Response:**
```json
{
  "data": {
    "totalPhotos": 1000,
    "photosWithFaces": 750,
    "totalFacesDetected": 1850,
    "averageFacesPerPhoto": 2.47
  }
}
```

### 3. Hybrid Search (Bib + Face)
```http
POST /events/:eventId/search/photos/hybrid

{
  "bib": "1234",
  "userImageBase64": "data:image/jpeg;base64,/9j/4AAQ...",
  "threshold": 0.6  
}
```

## Technical Implementation

### 1. Face Detection Service
- **Library**: Face-API.js with TinyFaceDetector
- **Models**: Detection + Landmarks + Descriptors + Age/Gender
- **Processing**: Server-side with Canvas polyfill
- **Output**: 128-dimensional descriptor per face

### 2. Similarity Calculation
```javascript
function calculateSimilarity(desc1, desc2) {
  // Euclidean distance
  let sum = 0;
  for (let i = 0; i < desc1.length; i++) {
    const diff = desc1[i] - desc2[i];
    sum += diff * diff;
  }
  const distance = Math.sqrt(sum);
  return Math.max(0, 1 - distance);
}
```

### 3. Thresholds
- **0.4**: Minimum for same person (Face-API standard)
- **0.6**: Default threshold (balanced)
- **0.75**: High confidence threshold

## Performance Characteristics

### Pre-processing (One-time per photo)
- **Face Detection**: ~2-5 seconds per photo
- **Storage**: 128 numbers per face (~2KB)
- **Batch Processing**: Background worker

### Search (Per user query)
- **Descriptor Extraction**: ~1-2 seconds (user photo)
- **Similarity Comparison**: ~0.1ms per face
- **Total Search Time**: ~2-3 seconds for 2000 faces

## Rate Limiting

```typescript
FACE_SEARCH_LIMITS = {
  ANONYMOUS: 3,    // searches per day
  REGISTERED: 10,  // searches per day  
  PREMIUM: 100,    // searches per day
  UNLIMITED: -1,   // photographers/admins
}
```

## Cost Analysis

### Pre-processing Costs
- **Face-API.js**: Free (local processing)
- **Storage**: $0.0001 per face embedding
- **Worker Time**: ~$0.01 per 100 photos

### Search Costs
- **Per Search**: ~$0.0001 (local computation only)
- **1000 searches/day**: ~$0.10/day
- **Break-even**: 1-2 photo sales cover costs

## Use Cases

### 1. Primary: "Find My Photos"
- Athlete uploads selfie
- System returns all photos where they appear
- Shows photos with watermarks for preview

### 2. Secondary: Cross-validation  
- Combine bib + face detection
- Verify bib belongs to correct person
- Reduce false positives

### 3. Future: Family/Team Search
- Upload group photo
- Find photos of multiple people
- Team/family package deals

## Privacy & Security

### 1. Data Storage
- **No face images stored** - only mathematical vectors
- **Vectors are anonymous** - cannot reconstruct faces
- **GDPR compliant** - vectors can be deleted

### 2. Processing
- **Local processing only** - no external APIs
- **Temporary face detection** - discarded after embedding
- **Opt-in basis** - users choose to enable face search

## Troubleshooting

### 1. No Face Detected
- Image too dark/blurry
- Face not facing camera
- Multiple faces (unclear which to use)
- **Solution**: Better user guidance, image preprocessing

### 2. Poor Matches
- Lighting conditions very different
- Significant age/appearance change  
- Extreme angles/expressions
- **Solution**: Lower threshold, multiple reference photos

### 3. Too Many False Positives
- Very similar looking people
- Poor lighting in event photos
- Low-resolution faces
- **Solution**: Higher threshold, better face quality checks

## Deployment Notes

### 1. Model Files
Face-API.js requires model files (~50MB total):
- `tiny_face_detector_model-weights_manifest.json` (1.2MB)
- `face_landmark_68_model-weights_manifest.json` (350KB) 
- `face_recognition_model-weights_manifest.json` (6.2MB)
- `age_gender_model-weights_manifest.json` (42MB)

### 2. Memory Requirements
- **Base**: 200MB for model loading
- **Per request**: +50MB during processing
- **Recommendation**: 1GB+ RAM for worker

### 3. CPU Usage
- **Face detection**: CPU intensive
- **Similarity search**: Very fast (pure math)
- **Recommendation**: Dedicated worker instances

## Monitoring

### Key Metrics
- Face detection success rate
- Average faces per photo
- Search response times  
- False positive/negative rates
- User engagement (searches → purchases)

### Alerting
- Face API service health
- Model loading failures
- Queue processing delays
- High error rates

## Future Enhancements

### 1. Multi-face Support
- Detect all faces in user's reference photo
- Match any face from the group
- Family/team searching

### 2. Quality Improvements  
- Face quality scoring
- Blur/lighting detection
- Auto-enhancement preprocessing

### 3. Advanced Features
- Age progression matching
- Pose normalization
- Expression invariance

### 4. Performance Optimizations
- Vector database (Pinecone/Weaviate)
- GPU acceleration
- Model quantization