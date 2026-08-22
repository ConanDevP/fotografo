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

export enum WorkspaceRole {
  OWNER = 'OWNER',
  ADMIN = 'ADMIN',
  EDITOR = 'EDITOR',
  PHOTOGRAPHER = 'PHOTOGRAPHER',
  ANALYST = 'ANALYST',
  SUPPORT = 'SUPPORT',
}

export enum EventCommerceMode {
  /// Paga el atleta; la plataforma retiene comisión por venta.
  PAID = 'PAID',
  /// El atleta no paga; el coste lo asume el fotógrafo por fotografía subida.
  FREE = 'FREE',
}

export enum MetricType {
  WORKSPACE_VIEW = 'WORKSPACE_VIEW',
  EVENT_VIEW = 'EVENT_VIEW',
  PHOTO_VIEW = 'PHOTO_VIEW',
  BIB_SEARCH = 'BIB_SEARCH',
  FACE_SEARCH = 'FACE_SEARCH',
  SEARCH_NO_RESULTS = 'SEARCH_NO_RESULTS',
  ADD_TO_CART = 'ADD_TO_CART',
  CHECKOUT_STARTED = 'CHECKOUT_STARTED',
  PURCHASE_COMPLETED = 'PURCHASE_COMPLETED',
  FREE_DOWNLOAD = 'FREE_DOWNLOAD',
  PAID_DOWNLOAD = 'PAID_DOWNLOAD',
  SPONSOR_CLICK = 'SPONSOR_CLICK',
  SPONSOR_DOWNLOAD_EXPOSURE = 'SPONSOR_DOWNLOAD_EXPOSURE',
}

export interface WorkspaceBrandTheme {
  template: string;
  primaryColor: string;
  secondaryColor: string;
  accentColor: string;
  fontFamily: string;
  heroTitle?: string;
  heroSubtitle?: string;
  showPastEvents: boolean;
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
  imageDimensions?: {
    width: number;
    height: number;
  };
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
  kind?: 'BIB_NOTIFICATION' | 'ORDER_CONFIRMATION' | 'EVENT_INVITATION';
  eventName?: string;
  workspaceName?: string;
  acceptanceUrl?: string;
  organizerCommissionPercent?: number;
  rightsTerms?: string;
  orderId?: string;
  downloadToken?: string;
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
  /// Ausente en un barrido: entonces se recorren todas las caras del evento que
  /// siguen sin dorsal, sin importar en qué fotografía estén.
  photoId?: string;
  eventId: string;
  /**
   * Repaso de evento completo. La inferencia por fotografía se lanza 45 s
   * después de procesarla, y para entonces la foto que enseña rostro y dorsal
   * juntos puede no haberse subido todavía. Sin este repaso, esas caras se
   * quedan sin número para siempre.
   */
  sweep?: boolean;
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
  /** Cosine similarity (0–1). Present for FACE_DIRECT matches, undefined for bib-graph discoveries. */
  similarity?: number;
  confidence: number;
  faceId: string;
  bbox: [number, number, number, number];
  thumbUrl?: string;
  watermarkUrl?: string;
  originalUrl?: string;
  /**
   * How this photo was discovered:
   *   FACE_DIRECT       – face was directly visible and similar to the query
   *   BIB_VIA_FACE      – found because the athlete's bib was confirmed in another photo
   *   INFERRED_VIA_FACE – found via a high-confidence inferred bib association
   */
  discoveryType?: 'FACE_DIRECT' | 'BIB_VIA_FACE' | 'INFERRED_VIA_FACE';
  /** Bibs detected/inferred in this specific photo */
  detectedBibs?: string[];
}

export interface FaceSearchResponse {
  matches: FaceSearchResult[];
  total: number;
  searchTime: number;
  userFaceDetected: boolean;
  /** Bibs confirmed for this athlete across the event (via spatial/KNN matching) */
  confirmedBibs?: string[];
  /** Bibs inferred with high confidence but not yet auto-verified */
  inferredBibs?: string[];
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
