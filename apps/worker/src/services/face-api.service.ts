import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as faceapi from 'face-api.js';
import { Canvas, Image, createCanvas, loadImage } from 'canvas';
import { join } from 'path';
import { FaceDetectionResult, FaceEmbeddingData } from '@shared/types';

// Polyfill for face-api.js to work with Node.js
const { env } = faceapi;
env.monkeyPatch({
  Canvas: Canvas as any,
  Image: Image as any,
  createCanvasElement: () => createCanvas(1, 1) as any,
  createImageElement: () => new Image() as any,
});

@Injectable()
export class FaceApiService implements OnModuleInit {
  private readonly logger = new Logger(FaceApiService.name);
  private modelsLoaded = false;

  async onModuleInit() {
    await this.loadModels();
  }

  private async loadModels() {
    try {
      this.logger.log('Loading Face-API models...');
      
      // In a real implementation, models would be stored in a models/ directory
      // For now, we'll load from node_modules
      const MODEL_URL = join(__dirname, '../../../../node_modules/face-api.js/weights');

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
    if (!this.modelsLoaded) {
      this.logger.warn('Face-API models not loaded, skipping face detection');
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
    if (!this.modelsLoaded) {
      this.logger.warn('Face-API models not loaded, cannot extract descriptor');
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

  calculateSimilarity(descriptor1: number[], descriptor2: number[]): number {
    if (descriptor1.length !== descriptor2.length) {
      throw new Error('Descriptors must have the same length');
    }

    // Calculate Euclidean distance
    let sum = 0;
    for (let i = 0; i < descriptor1.length; i++) {
      const diff = descriptor1[i] - descriptor2[i];
      sum += diff * diff;
    }
    
    const distance = Math.sqrt(sum);
    
    // Convert distance to similarity (0-1, where 1 is most similar)
    // Face-api.js typically uses 0.4 as the threshold for same person
    return Math.max(0, 1 - distance);
  }

  isMatch(similarity: number, threshold = 0.6): boolean {
    return similarity >= threshold;
  }

  private serializeLandmarks(landmarks: faceapi.FaceLandmarks68): number[][] {
    return landmarks.positions.map(point => [point.x, point.y]);
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