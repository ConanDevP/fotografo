import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FaceDetectionResult } from '@shared/types';
import * as sharp from 'sharp';

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

  private readonly faceApiKey: string;

  constructor(private configService: ConfigService) {
    this.pythonApiUrl = this.configService.get('PYTHON_FACE_API_URL', 'http://localhost:8000');
    this.faceApiKey = (this.configService.get<string>('FACE_API_KEY') || '').trim();

    if (!this.faceApiKey) {
      // La validación de entorno solo corre con NODE_ENV=production, así que
      // fuera de ahí una clave ausente pasaba sin aviso. Se detectaba mucho más
      // tarde, como un 401 por fotografía, indistinguible de una clave errónea.
      this.logger.error(
        'FACE_API_KEY no está configurada: el reconocimiento facial fallará con 401 en cada fotografía',
      );
    }
  }

  /**
   * Cabeceras de la llamada.
   *
   * Sin clave se corta aquí en vez de mandar una vacía. El servicio Python
   * responde a ambos casos con el mismo "Invalid face API credentials", así que
   * enviarla vacía convertía "no hay clave" en "la clave está mal" y mandaba a
   * buscar en el sitio equivocado.
   */
  private authHeaders(): Record<string, string> {
    if (!this.faceApiKey) {
      throw new Error(
        'FACE_API_KEY no está configurada en este servicio. El reconocimiento facial no puede autenticarse.',
      );
    }
    return { 'Content-Type': 'application/json', 'X-Face-API-Key': this.faceApiKey };
  }

  async detectAllFaces(imageUrl: string, maxFaces = 10, minConfidence = 0.5): Promise<FaceDetectionResult[]> {
    try {
      this.logger.log(`Calling Python Face API with image URL...`);

      const response = await fetch(`${this.pythonApiUrl}/extract-faces`, {
        method: 'POST',
        headers: this.authHeaders(),
        body: JSON.stringify({
          image_url: imageUrl, // Send signed URL directly
          max_faces: maxFaces,
          min_confidence: minConfidence,
        }),
        signal: AbortSignal.timeout(60_000),
      });

      if (!response.ok) {
        const errorText = await response.text();
        const truncatedError = errorText.length > 500 ? errorText.substring(0, 500) + '...[truncated]' : errorText;
        throw new Error(`Python API returned ${response.status}: ${truncatedError}`);
      }

      const data: PythonFaceApiResponse = await response.json();
      
      if (!data.success) {
        throw new Error(`Python Face API error: ${data.error || 'respuesta inválida'}`);
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
      // NO loggear el error completo porque puede incluir la imagen base64
      this.logger.error(`Error calling Python Face API: ${errorMessage.substring(0, 200)}`);
      throw error;
    }
  }

  async extractFaceDescriptor(imageBuffer: Buffer): Promise<Float32Array | null> {
    try {
      // Comprimir AGRESIVAMENTE para no exceder límite de 2083 caracteres
      // Para detección facial, 200px es suficiente y genera ~15KB = ~20K chars base64
      const compressedBuffer = await sharp(imageBuffer)
        .resize(200, 200, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 50 })
        .toBuffer();

      const base64Image = compressedBuffer.toString('base64');
      const dataUrl = `data:image/jpeg;base64,${base64Image}`;

      const requestPayload = {
        image_url: dataUrl, // Send as data URL (comprimida)
        max_faces: 1, // Only extract first face
        min_confidence: 0.3,
      };
      
      const response = await fetch(`${this.pythonApiUrl}/extract-faces`, {
        method: 'POST',
        headers: this.authHeaders(),
        body: JSON.stringify(requestPayload),
        signal: AbortSignal.timeout(60_000),
      });

      if (!response.ok) {
        const errorText = await response.text();
        // Truncar errorText para no loggear payloads con imágenes base64
        const truncatedError = errorText.length > 500 ? errorText.substring(0, 500) + '...[truncated]' : errorText;
        this.logger.error(`Python API error ${response.status}: ${truncatedError}`);
        throw new Error(`Python API returned ${response.status}`);
      }

      const data: PythonFaceApiResponse = await response.json();

      if (data.error) {
        this.logger.warn(`Python API error: ${data.error}`);
      }

      if (!data.success || data.faces.length === 0) {
        this.logger.warn(`No face detected in search image`);
        return null;
      }
      
      // Return first face's embedding as Float32Array
      return new Float32Array(data.faces[0].embedding);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      // NO loggear el error completo porque puede incluir la imagen base64
      this.logger.error(`Error extracting face descriptor: ${errorMessage.substring(0, 200)}`);
      return null;
    }
  }

  calculateDistance(descriptor1: number[], descriptor2: number[]): number {
    if (descriptor1.length !== descriptor2.length) {
      this.logger.error(`Descriptor length mismatch: ${descriptor1.length} vs ${descriptor2.length}`);
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
        // Sin `authHeaders()` a propósito: /health no pide autenticación y esta
        // comprobación debe poder responder "no está listo" en vez de lanzar.
        headers: this.faceApiKey ? { 'X-Face-API-Key': this.faceApiKey } : {},
        signal: AbortSignal.timeout(5000),
      });

      return response.ok;
    } catch (error) {
      this.logger.warn(`Python Face API health check failed: ${error}`);
      return false;
    }
  }

}
