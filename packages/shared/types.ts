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
}

export interface SearchResponse {
  items: PhotoSearchResult[];
  nextCursor?: string;
  total?: number;
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

// API Response types
export interface ApiResponse<T = any> {
  data?: T;
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
  };
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface UserProfile {
  id: string;
  email: string;
  role: UserRole;
  createdAt: string;
}