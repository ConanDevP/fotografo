export interface BatchStatusDetailed {
  id: string;
  status: string;
  totalFiles: number;
  uploadedFiles: number;
  processedFiles: number;
  
  // Pipeline breakdown
  watermarkFiles: number;
  geminiFiles: number;
  faceFiles: number;
  failedWatermarks: number;
  failedGemini: number;
  failedFaces: number;
  
  // Progress metrics
  progressPercentage: number;
  uploadProgress: number;
  processingProgress: number;
  
  // Time metrics
  startedAt: string;
  estimatedCompletion?: string;
  processingSpeed: number; // files per minute
  
  // Current status
  currentStep: string;
  isStuck: boolean;
  
  // Error details
  recentErrors: Array<{
    photoId: string;
    step: string;
    error: string;
    timestamp: string;
  }>;
  
  // Performance
  avgProcessingTime: number;
  bottleneck: string;
  throughput: {
    last5min: number;
    last15min: number;
    overall: number;
  };
}

export interface ProcessingPerformance {
  batchId: string;
  totalDuration: number;
  avgTimePerPhoto: number;
  currentSpeed: number; // photos/minute
  estimatedTimeRemaining: number;
  
  pipelinePerformance: {
    upload: { avgTime: number; success: number; failed: number };
    watermark: { avgTime: number; success: number; failed: number };
    ocr: { avgTime: number; success: number; failed: number };
    faceDetection: { avgTime: number; success: number; failed: number };
  };
  
  bottlenecks: Array<{
    step: string;
    avgTime: number;
    impact: 'low' | 'medium' | 'high';
  }>;
}

export interface UserDashboardStats {
  totalBatches: number;
  totalPhotosUploaded: number;
  totalPhotosProcessed: number;
  
  recentBatches: Array<{
    id: string;
    eventName: string;
    status: string;
    totalFiles: number;
    processedFiles: number;
    createdAt: string;
    completedAt?: string;
  }>;
  
  processingStats: {
    avgProcessingTime: number;
    successRate: number;
    totalErrors: number;
  };
  
  currentMonth: {
    batchesCreated: number;
    photosUploaded: number;
    photosProcessed: number;
  };
}