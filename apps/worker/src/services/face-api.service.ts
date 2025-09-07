import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { join } from 'path';
import { FaceDetectionResult, FaceEmbeddingData } from '@shared/types';

// Conditional imports for Canvas and Face-API
let faceapi: any;
let Canvas: any;
let Image: any;
let createCanvas: any;
let loadImage: any;

try {
  faceapi = require('face-api.js');
  const canvas = require('canvas');
  Canvas = canvas.Canvas;
  Image = canvas.Image;
  createCanvas = canvas.createCanvas;
  loadImage = canvas.loadImage;

  // Polyfill for face-api.js to work with Node.js
  const { env } = faceapi;
  env.monkeyPatch({
    Canvas: Canvas as any,
    Image: Image as any,
    createCanvasElement: () => createCanvas(1, 1) as any,
    createImageElement: () => new Image() as any,
  });
} catch (error) {
  console.warn('Face-API.js or Canvas not available, face recognition will be disabled');
}

@Injectable()
export class FaceApiService implements OnModuleInit {
  private readonly logger = new Logger(FaceApiService.name);
  private modelsLoaded = false;

  async onModuleInit() {
    await this.loadModels();
  }

  private async loadModels() {
    try {
      if (!faceapi) {
        this.logger.warn('Face-API.js not available, skipping model loading');
        return;
      }

      this.logger.log('Loading Face-API models...');
      
      // In a real implementation, models would be stored in a models/ directory
      // For now, we'll load from node_modules
      const MODEL_URL = join(process.cwd(), 'node_modules/face-api.js/weights');
      this.logger.log(`Looking for models at: ${MODEL_URL}`);

      await Promise.all([
        faceapi.nets.tinyFaceDetector.loadFromDisk(MODEL_URL),
        faceapi.nets.faceLandmark68Net.loadFromDisk(MODEL_URL),
        faceapi.nets.faceRecognitionNet.loadFromDisk(MODEL_URL),
        faceapi.nets.ageGenderNet.loadFromDisk(MODEL_URL),
      ]);

      this.modelsLoaded = true;
      this.logger.log('Face-API models loaded successfully');
    } catch (error) {
      this.logger.error('Failed to load Face-API models:', error);
      // Don't throw - continue without face recognition
      this.logger.warn('Face recognition will be disabled');
    }
  }

  async detectAllFaces(imageUrl: string): Promise<FaceDetectionResult[]> {
    if (!this.modelsLoaded || !faceapi || !loadImage) {
      this.logger.warn('Face-API not available, skipping face detection');
      return [];
    }

    try {
      this.logger.debug(`Detecting faces in image: ${imageUrl}`);
      
      // Load image from URL
      const img = await loadImage(imageUrl);
      
      // Detect all faces with landmarks and descriptors
      const detections = await faceapi
        .detectAllFaces(img as any, new faceapi.TinyFaceDetectorOptions())
        .withFaceLandmarks()
        .withFaceDescriptors()
        .withAgeAndGender();

      this.logger.log(`Detected ${detections.length} faces in image`);

      // Convert to our format
      const results: FaceDetectionResult[] = detections.map((detection, index) => {
        const box = detection.detection.box;
        const descriptor = Array.from(detection.descriptor);
        
        return {
          id: `face_${Date.now()}_${index}`,
          confidence: detection.detection.score,
          bbox: [box.x, box.y, box.width, box.height],
          embedding: descriptor,
          landmarks: this.serializeLandmarks(detection.landmarks),
          age: Math.round(detection.age || 0),
          gender: detection.gender || 'unknown',
        };
      });

      return results;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Error detecting faces: ${errorMessage}`);
      return [];
    }
  }

  async extractFaceDescriptor(imageBuffer: Buffer): Promise<Float32Array | null> {
    if (!this.modelsLoaded || !faceapi || !loadImage) {
      this.logger.warn('Face-API not available, cannot extract descriptor');
      return null;
    }

    try {
      const img = await loadImage(imageBuffer);
      
      const detection = await faceapi
        .detectSingleFace(img as any, new faceapi.TinyFaceDetectorOptions())
        .withFaceLandmarks()
        .withFaceDescriptor();

      if (!detection) {
        this.logger.warn('No face detected in provided image');
        return null;
      }

      return detection.descriptor;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Error extracting face descriptor: ${errorMessage}`);
      return null;
    }
  }

  calculateDistance(descriptor1: number[], descriptor2: number[]): number {
    if (descriptor1.length !== descriptor2.length) {
      this.logger.error('Descriptors must have the same length for distance calculation');
      // Return a large distance to indicate a non-match
      return 999;
    }

    // Use face-api.js's built-in EuclideanDistance for consistency
    return faceapi.euclideanDistance(descriptor1, descriptor2);
  }

  isMatch(distance: number, threshold = 0.4): boolean {
    return distance <= threshold;
  }

  private serializeLandmarks(landmarks: any): number[][] {
    return landmarks.positions.map((point: any) => [point.x, point.y]);
  }

  private async fetchImageAsBuffer(url: string): Promise<Buffer> {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      const arrayBuffer = await response.arrayBuffer();
      return Buffer.from(arrayBuffer);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to fetch image: ${errorMessage}`);
    }
  }

  // Utility method for batch processing
  async processFacesInBatch(imageUrls: string[]): Promise<Map<string, FaceDetectionResult[]>> {
    const results = new Map<string, FaceDetectionResult[]>();
    
    for (const imageUrl of imageUrls) {
      try {
        const faces = await this.detectAllFaces(imageUrl);
        results.set(imageUrl, faces);
      } catch (error) {
        this.logger.error(`Failed to process ${imageUrl}:`, error);
        results.set(imageUrl, []);
      }
    }
    
    return results;
  }

  // Health check method
  isReady(): boolean {
    return this.modelsLoaded;
  }
}