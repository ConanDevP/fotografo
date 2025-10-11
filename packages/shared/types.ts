// Enums compartidos
export enum UserRole {
  ATHLETE = 'ATHLETE',
  PHOTOGRAPHER = 'PHOTOGRAPHER',
  ADMIN = 'ADMIN',
}

export enum PhotoStatus {
  PENDING = 'PENDING',
  PROCESSED = 'PROCESSED',
  FAILED = 'FAILED',
}

export enum OrderStatus {
  CREATED = 'CREATED',
  PAID = 'PAID',
  CANCELLED = 'CANCELLED',
  REFUNDED = 'REFUNDED',
}

export enum ItemType {
  PHOTO = 'PHOTO',
  PACKAGE = 'PACKAGE',
}

// Interfaces
export interface BibRules {
  minLen?: number;
  maxLen?: number;
  regex?: string;
  whitelist?: string[];
  range?: [number, number];
}

export interface EventPricing {
  singlePhoto: number; // Precio en centavos
  pack5: number;       // Pack de 5 fotos
  pack10: number;      // Pack de 10 fotos  
  allPhotos: number;   // Todas las fotos del dorsal
  currency: string;    // USD, EUR, etc.
}

export interface DetectedBib {
  value: string;
  confidence: number;
  bbox?: [number, number, number, number]; // [x, y, width, height]
}

export interface GeminiOCRResponse {
  bibs: DetectedBib[];
  notes?: string;
  usage?: {
    promptTokens: number;
    candidatesTokens: number;
    totalTokens: number;
  };
}

export interface PhotoSearchResult {
  photoId: string;
  thumbUrl: string;
  watermarkUrl: string;
  originalUrl: string;
  confidence: number;
  takenAt?: string;
  type?: 'DETECTED' | 'INFERRED'; // NEW: Type of bib detection
  faceBbox?: [number, number, number, number]; // NEW: For inferred bibs
}

export interface SearchResponse {
  items: PhotoSearchResult[];
  nextCursor?: string;
  total?: number;
  stats?: { // NEW: Statistics for detected vs inferred
    detected: number;
    inferred: number;
  };
}

// Job payloads
export interface ProcessPhotoJob {
  photoId: string;
  eventId: string;
  objectKey: string;
}

export interface SendBibEmailJob {
  eventId: string;
  bib: string;
  email: string;
  photoIds?: string[];
}

export interface ReprocessPhotoJob {
  photoId: string;
  strategy?: 'flash' | 'pro';
}

export interface ProcessFaceJob {
  photoId: string;
  eventId: string;
  imageUrl: string;
}

// NEW: Infer Bibs Job
export interface InferBibsJob {
  photoId: string;
  eventId: string;
}

// Face Recognition Types
export interface FaceDetectionResult {
  id: string;
  confidence: number;
  bbox: [number, number, number, number]; // [x, y, width, height]
  embedding: number[]; // 128-dimensional descriptor
  landmarks?: number[][]; // Facial landmarks points
  age?: number;
  gender?: string;
}

export interface FaceEmbeddingData {
  id: string;
  photoId: string;
  eventId: string;
  embedding: number[];
  confidence: number;
  bbox: [number, number, number, number];
  landmarks?: number[][];
  age?: number;
  gender?: string;
  createdAt: string;
}

export interface FaceSearchRequest {
  userImageBase64: string;
  threshold?: number; // Similarity threshold (0-1)
}

export interface FaceSearchResult {
  photoId: string;
  similarity: number;
  confidence: number;
  faceId: string;
  bbox: [number, number, number, number];
  thumbUrl?: string;
  watermarkUrl?: string;
  originalUrl?: string;
}

export interface FaceSearchResponse {
  matches: FaceSearchResult[];
  total: number;
  searchTime: number;
  userFaceDetected: boolean;
}

// API Response types
export interface ApiResponse<T = any> {
  data?: T;
  message?: string;
  error?: {
    code: string;
    message: string;
    details?: any;
  };
  meta?: {
    pagination?: {
      page: number;
      limit: number;
      total: number;
      pages: number;
    };
    cursor?: string;
    total?: number;
    optimized?: boolean;
    searchTime?: number;
  };
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface UserProfile {
  id: string;
  email: string;
  name?: string;
  phone?: string;
  profileImageUrl?: string;
  address?: string;
  role: UserRole;
  createdAt: string;
}

// ═══════════════════════════════════════════════════════════════════
// Face-Bib Linking Types (NEW)
// ═══════════════════════════════════════════════════════════════════

export interface FaceBibMatch {
  faceIndex: number;
  bibValue: string;
  spatialScore: number;
}

export interface FaceBibAssociationData {
  id: string;
  faceEmbeddingId: string;
  photoBibId: number;
  photoId: string;
  eventId: string;
  bib: string;
  spatialScore: number;
  method: 'SPATIAL' | 'MANUAL' | 'INFERRED';
  createdAt: string;
}

export interface AthleteSignatureData {
  id: string;
  eventId: string;
  bib: string;
  faceSignature: number[];
  sampleCount: number;
  confidence: number;
  createdAt: string;
  updatedAt: string;
}

export interface InferredBibData {
  id: string;
  photoId: string;
  faceEmbeddingId: string;
  eventId: string;
  bib: string;
  confidence: number;
  faceDistance: number;
  inferredFrom: string;
  verified: boolean;
  rejected: boolean;
  createdAt: string;
}

export interface InferredBibReview {
  id: string;
  photoId: string;
  thumbUrl: string;
  bib: string;
  confidence: number;
  faceBbox: [number, number, number, number];
  verified: boolean;
  rejected: boolean;
}