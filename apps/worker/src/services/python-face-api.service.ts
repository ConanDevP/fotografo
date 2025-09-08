import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FaceDetectionResult } from '@shared/types';

interface PythonFaceApiResponse {
  success: boolean;
  faces_detected: number;
  faces: {
    bbox: [number, number, number, number];
    embedding: number[];
    confidence: number;
  }[];
  error?: string;
}

@Injectable()
export class PythonFaceApiService {
  private readonly logger = new Logger(PythonFaceApiService.name);
  private readonly pythonApiUrl: string;

  constructor(private configService: ConfigService) {
    this.pythonApiUrl = this.configService.get('PYTHON_FACE_API_URL', 'http://localhost:8000');
  }

  async detectAllFaces(imageUrl: string, maxFaces = 10): Promise<FaceDetectionResult[]> {
    try {
      this.logger.debug(`Detecting faces in image: ${imageUrl}`);
      
      const response = await fetch(`${this.pythonApiUrl}/extract-faces`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          image_url: imageUrl,
          max_faces: maxFaces,
          min_confidence: 0.3,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Python API returned ${response.status}: ${errorText}`);
      }

      const data: PythonFaceApiResponse = await response.json();
      
      if (!data.success) {
        this.logger.warn(`Python Face API error: ${data.error}`);
        return [];
      }

      this.logger.log(`Detected ${data.faces_detected} faces in image`);

      // Convert to our FaceDetectionResult format
      const results: FaceDetectionResult[] = data.faces.map((face, index) => ({
        id: `face_${Date.now()}_${index}`,
        confidence: face.confidence,
        bbox: face.bbox,
        embedding: face.embedding, // 512-dimensional embedding from InsightFace
        landmarks: [], // Not provided by Python API - could be added later
        age: 0, // Not provided by Python API - could be added later  
        gender: 'unknown', // Not provided by Python API - could be added later
      }));

      return results;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Error calling Python Face API: ${errorMessage}`);
      return [];
    }
  }

  async extractFaceDescriptor(imageBuffer: Buffer): Promise<Float32Array | null> {
    try {
      // Convert buffer to base64 for sending to Python API
      const base64Image = imageBuffer.toString('base64');
      const dataUrl = `data:image/jpeg;base64,${base64Image}`;
      
      this.logger.log(`Calling Python API for face extraction...`);
      this.logger.log(`Image buffer size: ${imageBuffer.length} bytes`);
      this.logger.log(`Base64 image size: ${base64Image.length} characters`);
      
      const requestPayload = {
        image_url: dataUrl, // Send as data URL
        max_faces: 1, // Only extract first face
        min_confidence: 0.3,
      };
      
      this.logger.log(`Sending request to ${this.pythonApiUrl}/extract-faces with confidence: ${requestPayload.min_confidence}`);
      
      const response = await fetch(`${this.pythonApiUrl}/extract-faces`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestPayload),
      });

      this.logger.log(`Python API responded with status: ${response.status}`);

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error(`Python API error response: ${errorText}`);
        throw new Error(`Python API returned ${response.status}: ${errorText}`);
      }

      const data: PythonFaceApiResponse = await response.json();
      
      this.logger.log(`Python API response: success=${data.success}, faces_detected=${data.faces_detected}`);
      
      if (data.error) {
        this.logger.warn(`Python API returned error: ${data.error}`);
      }
      
      if (!data.success || data.faces.length === 0) {
        this.logger.warn(`No face detected in search image - success: ${data.success}, faces: ${data.faces.length}`);
        return null;
      }

      this.logger.log(`Face detected successfully! Confidence: ${data.faces[0].confidence}, embedding size: ${data.faces[0].embedding.length}`);
      
      // Return first face's embedding as Float32Array
      return new Float32Array(data.faces[0].embedding);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Error extracting face descriptor: ${errorMessage}`);
      return null;
    }
  }

  calculateDistance(descriptor1: number[], descriptor2: number[]): number {
    if (descriptor1.length !== descriptor2.length) {
      this.logger.error('Descriptors must have the same length for distance calculation');
      return 999; // Return large distance for non-match
    }

    // Calculate cosine similarity and convert to distance
    // Cosine similarity ranges from -1 to 1, where 1 is most similar
    const similarity = this.calculateCosineSimilarity(descriptor1, descriptor2);
    
    // Convert to distance: distance = 1 - similarity
    // This gives us a range from 0 (identical) to 2 (opposite)
    return 1 - similarity;
  }

  private calculateCosineSimilarity(a: number[], b: number[]): number {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
    
    if (magnitude === 0) {
      return 0;
    }

    return dotProduct / magnitude;
  }

  isMatch(distance: number, threshold = 0.4): boolean {
    // With cosine distance, lower values mean more similar faces
    return distance <= threshold;
  }

  // Health check method
  async isReady(): Promise<boolean> {
    try {
      const response = await fetch(`${this.pythonApiUrl}/health`, {
        method: 'GET',
        timeout: 5000, // 5 second timeout
      } as RequestInit);

      return response.ok;
    } catch (error) {
      this.logger.warn(`Python Face API health check failed: ${error}`);
      return false;
    }
  }

  // Synchronous version for backward compatibility
  isReadySync(): boolean {
    // For now, assume it's ready - in production you might want to cache the health status
    return true;
  }
}