import * as path from 'path';

// Queue names
export const QUEUES = {
  PROCESS_PHOTO: 'process-photo',
  PROCESS_FACE: 'process-face',
  SEND_BIB_EMAIL: 'send-bib-email',
  REPROCESS_PHOTO: 'reprocess-photo',
  INFER_BIBS: 'infer-bibs', // NEW: Queue for bib inference
} as const;

// Job names
export const JOBS = {
  PROCESS_PHOTO: 'process-photo',
  PROCESS_FACE: 'process-face',
  SEND_BIB_EMAIL: 'send-bib-email',
  REPROCESS_PHOTO: 'reprocess-photo',
  INFER_BIBS: 'infer-bibs',
} as const;

// Error codes
export const ERROR_CODES = {
  // Auth
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',

  // Users
  USER_NOT_FOUND: 'USER_NOT_FOUND',
  EMAIL_ALREADY_EXISTS: 'EMAIL_ALREADY_EXISTS',
  USER_ALREADY_EXISTS: 'USER_ALREADY_EXISTS',
  SLUG_ALREADY_EXISTS: 'SLUG_ALREADY_EXISTS',
  USER_HAS_DEPENDENCIES: 'USER_HAS_DEPENDENCIES',

  // Events
  EVENT_NOT_FOUND: 'EVENT_NOT_FOUND',
  INVALID_EVENT_SLUG: 'INVALID_EVENT_SLUG',
  EVENT_NOT_DELETED: 'EVENT_NOT_DELETED',

  // Photos
  PHOTO_NOT_FOUND: 'PHOTO_NOT_FOUND',
  INVALID_PHOTO_FORMAT: 'INVALID_PHOTO_FORMAT',
  PHOTO_TOO_LARGE: 'PHOTO_TOO_LARGE',
  UPLOAD_FAILED: 'UPLOAD_FAILED',
  BATCH_NOT_FOUND: 'BATCH_NOT_FOUND',
  BATCH_JOB_NOT_FOUND: 'BATCH_JOB_NOT_FOUND',
  JOB_NOT_FOUND: 'JOB_NOT_FOUND',
  JOB_COMPLETED: 'JOB_COMPLETED',

  // Bibs
  BIB_NOT_FOUND: 'BIB_NOT_FOUND',
  INVALID_BIB_FORMAT: 'INVALID_BIB_FORMAT',

  // Orders
  ORDER_NOT_FOUND: 'ORDER_NOT_FOUND',
  PAYMENT_FAILED: 'PAYMENT_FAILED',
  ALREADY_PURCHASED: 'ALREADY_PURCHASED',
  DOWNLOAD_FAILED: 'DOWNLOAD_FAILED',
  CANNOT_DELETE_ORDER: 'CANNOT_DELETE_ORDER',

  // Subscriptions
  SUBSCRIPTION_NOT_FOUND: 'SUBSCRIPTION_NOT_FOUND',

  // General
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

// File constraints
export const FILE_CONSTRAINTS = {
  /// Tope de peso. Generoso a propósito: quien paga el almacenamiento no debe
  /// además pelearse con el tamaño del archivo. Lo que de verdad protege al
  /// procesamiento es MAX_PIXELS, porque la memoria la consumen los píxeles
  /// descomprimidos, no los bytes en disco.
  MAX_SIZE: 100 * 1024 * 1024,
  /// Un JPEG de estos píxeles ocupa ~240 MB ya descomprimido en memoria, y de
  /// cada fotografía se generan tres derivadas.
  MAX_PIXELS: 80_000_000,
  MAX_DIMENSION: 20_000,
  ALLOWED_TYPES: ['image/jpeg', 'image/jpg', 'image/png'] as readonly string[],
  ALLOWED_EXTENSIONS: ['.jpg', '.jpeg', '.png'],
} as const;

// Image processing
export const IMAGE_SIZES = {
  THUMB: { width: 800, quality: 70 },
  WATERMARK: { width: 2000, quality: 80 },
  OCR_PREPROCESS: { width: 3000 },
} as const;

// Gemini
export const GEMINI_MODELS = {
  FLASH: 'gemini-2.5-flash-lite',
  PRO: 'gemini-2.5-pro',
} as const;

// Rate limits (per minute)
export const RATE_LIMITS = {
  SEARCH: 60,
  EMAIL: 5,
  UPLOAD: 20,
  DEFAULT: 100,
} as const;

// Pagination
export const PAGINATION = {
  DEFAULT_LIMIT: 50,
  MAX_LIMIT: 100,
} as const;

// Cloudinary paths
export const CLOUDINARY_FOLDERS = {
  ORIGINAL: (eventId: string, bib?: string) =>
    bib ? `events/${eventId}/original/dorsal-${bib}` : `events/${eventId}/original`,
  THUMB: (eventId: string, bib?: string) =>
    bib ? `events/${eventId}/thumb/dorsal-${bib}` : `events/${eventId}/thumb`,
  WATERMARK: (eventId: string, bib?: string) =>
    bib ? `events/${eventId}/wm/dorsal-${bib}` : `events/${eventId}/wm`,
} as const;

// Cloudinary transformations
export const CLOUDINARY_TRANSFORMS = {
  THUMB: 'w_800,c_limit,q_70,f_jpg',
  WATERMARK: 'w_2000,c_limit,q_80,f_jpg,l_text:Arial_60_bold:%C2%A9%20Fotografo,o_30',
  OCR_PREPROCESS: 'w_3000,c_limit,q_90,f_jpg,e_auto_contrast:10',
} as const;

// URL expiry times
export const URL_EXPIRY = {
  UPLOAD: 15 * 60, // 15 minutes
  DOWNLOAD: 5 * 60, // 5 minutes
} as const;

// Face Recognition
export const FACE_RECOGNITION = {
  /**
   * Distancia COSENO máxima (1 − similitud) para considerar que una selfie
   * corresponde a una cara del evento. No es euclídea, aunque lo dijera el
   * comentario anterior: `calculateDistance` calcula coseno.
   *
   * Se alinea con KNN_STRICT_DISTANCE a propósito. Estaba en 0.4, más laxo que
   * el umbral con el que el sistema se atreve a etiquetar un dorsal, lo que
   * dejaba la parte que enseña fotos a un desconocido más permisiva que la
   * automatización interna. Un falso positivo aquí es un problema de privacidad.
   */
  DEFAULT_THRESHOLD: 0.3,
  MAX_FACES_PER_PHOTO: 20, // Maximum faces to detect per photo
  FACEAPI_MODEL_PATH: path.join(__dirname, '..', '..', '..', 'models', 'face-api'),
  DESCRIPTOR_LENGTH: 128,  // Length of face descriptor vector
};

// Face Search Rate Limits
export const FACE_SEARCH_LIMITS = {
  ANONYMOUS: 3,    // 3 searches per day for anonymous users
  REGISTERED: 10,  // 10 searches per day for registered users
  PREMIUM: 100,    // 100 searches per day for premium users
  UNLIMITED: -1,   // Unlimited for photographers/admins
} as const;

// Face-Bib Linking Configuration (NEW)
export const FACE_BIB_LINKING = {
  /// Puntuación mínima de proximidad horizontal para aceptar un emparejamiento
  /// cara↔dorsal. Es el único parámetro espacial que el código usa: el
  /// emparejamiento compara distancia horizontal y descarta el eje vertical.
  SPATIAL_SCORE_THRESHOLD: 0.35,

  // Inference thresholds
  INFERENCE_THRESHOLD: 0.45,           // Relaxed for better recall
  MIN_SIGNATURE_SAMPLES: 1,            // Allow inference from first photo
  MIN_SIGNATURE_CONFIDENCE: 0.60,      // Lower threshold for signature reliability
  SIGNATURE_CONFIDENCE_START: 0.75,    // Higher initial confidence
  SIGNATURE_CONFIDENCE_INCREMENT: 0.03, // Faster confidence increase
  SIGNATURE_EMA_ALPHA: 0.4,            // More weight to new embeddings
  AUTO_VERIFY_CONFIDENCE: 0.85,        // Lower auto-verify threshold
  KNN_STRICT_DISTANCE: 0.30,           // Relaxed: auto-assign when distance below this
  KNN_RELAXED_DISTANCE: 0.45,          // Relaxed: create pending inference
  KNN_MAX_RESULTS: 10,                 // More neighbours to evaluate
  INDEX_MIN_CONFIDENCE: 0.5,           // Lower threshold to index more embeddings

  // Quality filters
  MIN_GEMINI_CONFIDENCE: 0.70,         // Lower threshold for Gemini detections
  MIN_INFERRED_CONFIDENCE: 0.55,       // Lower threshold to show inferred bibs

} as const;
