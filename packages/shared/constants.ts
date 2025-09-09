import * as path from 'path';

// Queue names
export const QUEUES = {
  PROCESS_PHOTO: 'process-photo',
  PROCESS_FACE: 'process-face',
  SEND_BIB_EMAIL: 'send-bib-email',
  REPROCESS_PHOTO: 'reprocess-photo',
} as const;

// Job names
export const JOBS = {
  PROCESS_PHOTO: 'process-photo',
  PROCESS_FACE: 'process-face',
  SEND_BIB_EMAIL: 'send-bib-email',
  REPROCESS_PHOTO: 'reprocess-photo',
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
  
  // Events
  EVENT_NOT_FOUND: 'EVENT_NOT_FOUND',
  INVALID_EVENT_SLUG: 'INVALID_EVENT_SLUG',
  
  // Photos
  PHOTO_NOT_FOUND: 'PHOTO_NOT_FOUND',
  INVALID_PHOTO_FORMAT: 'INVALID_PHOTO_FORMAT',
  PHOTO_TOO_LARGE: 'PHOTO_TOO_LARGE',
  UPLOAD_FAILED: 'UPLOAD_FAILED',
  BATCH_NOT_FOUND: 'BATCH_NOT_FOUND',
  
  // Bibs
  BIB_NOT_FOUND: 'BIB_NOT_FOUND',
  INVALID_BIB_FORMAT: 'INVALID_BIB_FORMAT',
  
  // Orders
  ORDER_NOT_FOUND: 'ORDER_NOT_FOUND',
  PAYMENT_FAILED: 'PAYMENT_FAILED',
  ALREADY_PURCHASED: 'ALREADY_PURCHASED',
  DOWNLOAD_FAILED: 'DOWNLOAD_FAILED',
  
  // General
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

// File constraints
export const FILE_CONSTRAINTS = {
  MAX_SIZE: 20 * 1024 * 1024, // 20MB
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
  FLASH: 'gemini-1.5-flash',
  PRO: 'gemini-1.5-pro',
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
  DEFAULT_THRESHOLD: 0.4, // Euclidean distance threshold. Lower is more similar. Recommended: 0.4 for high confidence.
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