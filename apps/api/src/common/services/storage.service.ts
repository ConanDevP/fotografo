import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CloudinaryService } from './cloudinary.service';
import { R2Service } from './r2.service';
import { SharpTransformService } from './sharp-transform.service';

@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly provider: 'cloudinary' | 'r2';

  constructor(
    private configService: ConfigService,
    private cloudinaryService: CloudinaryService,
    private r2Service: R2Service,
    private sharpService: SharpTransformService,
  ) {
    this.provider = this.configService.get('STORAGE_PROVIDER', 'cloudinary') as 'cloudinary' | 'r2';
    this.logger.log(`Storage provider configurado: ${this.provider}`);
  }

  async uploadPhoto(
    file: Express.Multer.File,
    eventId: string,
    photoId: string,
  ): Promise<{
    cloudinaryId: string;
    originalUrl: string;
    width: number;
    height: number;
  }> {
    if (this.provider === 'r2') {
      // Con R2, obtenemos las dimensiones usando Sharp
      const metadata = await this.sharpService.getImageMetadata(file.buffer);
      const result = await this.r2Service.uploadPhoto(file, eventId, photoId);
      
      return {
        ...result,
        width: metadata.width,
        height: metadata.height,
      };
    }
    
    return this.cloudinaryService.uploadPhoto(file, eventId, photoId);
  }

  // Cache para evitar descargar la misma imagen múltiples veces
  private imageBufferCache = new Map<string, Promise<Buffer>>();
  // Mutex para evitar race conditions en concurrent downloads
  private downloadMutex = new Map<string, Promise<void>>();

  async generateThumbnail(cloudinaryId: string, eventId: string, photoId: string): Promise<string> {
    if (this.provider === 'r2') {
      // Con R2, descargamos la imagen original, generamos thumbnail con Sharp y subimos
      try {
        const originalKey = cloudinaryId; // En R2, cloudinaryId es el key
        const thumbnailKey = `events/${eventId}/thumb/${photoId}.jpg`;
        
        // Obtenemos la imagen original (con cache)
        const originalBuffer = await this.getCachedImageBuffer(originalKey);
        
        // Generamos thumbnail con Sharp
        const thumbnailBuffer = await this.sharpService.generateThumbnail(originalBuffer);
        
        // Subimos el thumbnail
        const thumbnailUrl = await this.r2Service.uploadImage(thumbnailBuffer, thumbnailKey);
        
        this.logger.log(`Thumbnail generado en R2: ${thumbnailKey}`);
        return thumbnailUrl;
      } catch (error) {
        this.logger.error(`Error generando thumbnail en R2:`, error);
        throw error;
      }
    }

    return this.cloudinaryService.generateThumbnail(cloudinaryId, eventId, photoId);
  }

  async generateWatermark(cloudinaryId: string, eventId: string, photoId: string): Promise<string> {
    if (this.provider === 'r2') {
      try {
        const originalKey = cloudinaryId;
        const watermarkKey = `events/${eventId}/wm/${photoId}.jpg`;
        
        // Obtenemos la imagen original (con cache)
        const originalBuffer = await this.getCachedImageBuffer(originalKey);
        
        // Generamos watermark con Sharp
        const watermarkBuffer = await this.sharpService.generateWatermark(originalBuffer);
        
        // Subimos el watermark
        const watermarkUrl = await this.r2Service.uploadImage(watermarkBuffer, watermarkKey);
        
        this.logger.log(`Watermark generado en R2: ${watermarkKey}`);
        return watermarkUrl;
      } catch (error) {
        this.logger.error(`Error generando watermark en R2:`, error);
        throw error;
      }
    }

    return this.cloudinaryService.generateWatermark(cloudinaryId, eventId, photoId);
  }

  async getOptimizedUrlForOCR(cloudinaryId: string): Promise<string> {
    if (this.provider === 'r2') {
      // Para R2, usamos URL firmada temporal para OCR (15 minutos)
      return this.r2Service.generateSecureDownloadUrl(cloudinaryId, 900);
    }

    return this.cloudinaryService.getOptimizedUrlForOCR(cloudinaryId);
  }

  async generateSecureDownloadUrl(cloudinaryId: string, expiresIn = 300): Promise<string> {
    if (this.provider === 'r2') {
      return this.r2Service.generateSecureDownloadUrl(cloudinaryId, expiresIn);
    }

    return this.cloudinaryService.generateSecureDownloadUrl(cloudinaryId, expiresIn);
  }

  async deletePhoto(cloudinaryId: string): Promise<void> {
    if (this.provider === 'r2') {
      return this.r2Service.deletePhoto(cloudinaryId);
    }

    return this.cloudinaryService.deletePhoto(cloudinaryId);
  }

  buildUrl(cloudinaryId: string, transformation?: string): string {
    if (this.provider === 'r2') {
      // R2 no tiene transformaciones dinámicas, retornamos la URL base
      return this.r2Service.buildUrl(cloudinaryId);
    }

    return this.cloudinaryService.buildUrl(cloudinaryId, transformation);
  }

  async uploadImage(
    buffer: Buffer,
    publicId: string,
    transformation?: { width?: number; height?: number; crop?: string }
  ): Promise<{ secure_url: string; public_id: string }> {
    if (this.provider === 'r2') {
      let processedBuffer = buffer;
      
      // Aplicar transformaciones con Sharp si se especifican
      if (transformation?.width || transformation?.height) {
        processedBuffer = await this.sharpService.resizeImage(
          buffer, 
          transformation.width, 
          transformation.height
        );
      }
      
      const url = await this.r2Service.uploadImage(processedBuffer, publicId);
      return {
        secure_url: url,
        public_id: publicId,
      };
    }

    const result = await this.cloudinaryService.uploadImage(buffer, publicId, transformation);
    return {
      secure_url: result.secure_url,
      public_id: result.public_id,
    };
  }

  async deleteImage(publicId: string): Promise<void> {
    if (this.provider === 'r2') {
      return this.r2Service.deleteImage(publicId);
    }

    return this.cloudinaryService.deleteImage(publicId);
  }

  private async getCachedImageBuffer(key: string): Promise<Buffer> {
    // CRITICAL FIX: Thread-safe concurrent download management
    
    // Si ya tenemos el buffer cached, retornarlo inmediatamente
    if (this.imageBufferCache.has(key)) {
      return this.imageBufferCache.get(key)!;
    }
    
    // Si ya hay un download en progreso, esperar a que termine
    if (this.downloadMutex.has(key)) {
      await this.downloadMutex.get(key)!;
      // Después de esperar, el buffer debería estar disponible
      if (this.imageBufferCache.has(key)) {
        return this.imageBufferCache.get(key)!;
      }
    }
    
    // CRITICAL: Crear mutex antes de iniciar download
    let resolveMutex: () => void;
    const mutexPromise = new Promise<void>(resolve => {
      resolveMutex = resolve;
    });
    this.downloadMutex.set(key, mutexPromise);
    
    try {
      // Solo el primer thread llegará aquí y hará el download
      this.logger.log(`Iniciando download exclusivo para: ${key}`);
      const downloadPromise = this.getImageBuffer(key);
      this.imageBufferCache.set(key, downloadPromise);
      
      // Esperar que termine el download
      const buffer = await downloadPromise;
      
      // Limpiar cache después de 5 minutos para evitar memory leaks
      setTimeout(() => {
        this.imageBufferCache.delete(key);
        this.logger.debug(`Cache limpiado para: ${key}`);
      }, 5 * 60 * 1000);
      
      this.logger.log(`Download completado exitosamente para: ${key} (${buffer.length} bytes)`);
      return buffer;
      
    } finally {
      // CRITICAL: Siempre liberar el mutex
      this.downloadMutex.delete(key);
      resolveMutex!();
    }
  }

  private async getImageBuffer(key: string): Promise<Buffer> {
    // ENHANCED: Método auxiliar robusto para descargar imágenes
    let lastError: Error | undefined;
    const startTime = Date.now();
    
    // Retry hasta 3 veces en caso de errores de red
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        this.logger.log(`[${key}] Intento ${attempt}/3 - Generando URL firmada...`);
        
        // CRITICAL: URL con mayor tiempo de expiración para evitar race conditions
        const url = await this.r2Service.generateSecureDownloadUrl(key, 900); // 15 minutos
        
        this.logger.log(`[${key}] Descargando imagen desde R2...`);
        const response = await fetch(url, {
          // ENHANCED: Headers para mejor reliability
          headers: {
            'User-Agent': 'Node.js/ImageDownloader',
          },
          // CRITICAL: Timeout para evitar hanging requests
          signal: AbortSignal.timeout(30000) // 30 segundos timeout
        });
        
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        
        // ENHANCED: Validaciones más estrictas
        if (buffer.length < 1000) {
          throw new Error(`Buffer muy pequeño: ${buffer.length} bytes - imagen corrupta`);
        }
        
        // Validar que sea una imagen válida (magic bytes)
        const isValidImage = this.validateImageBuffer(buffer);
        if (!isValidImage) {
          throw new Error(`Buffer no es una imagen válida para ${key}`);
        }
        
        const downloadTime = Date.now() - startTime;
        this.logger.log(`[${key}] ✅ Descarga exitosa: ${buffer.length} bytes en ${downloadTime}ms (intento ${attempt})`);
        return buffer;
        
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        const attemptTime = Date.now() - startTime;
        this.logger.warn(`[${key}] ❌ Intento ${attempt}/3 falló en ${attemptTime}ms: ${lastError.message}`);
        
        if (attempt < 3) {
          // ENHANCED: Backoff exponencial más agresivo para race conditions
          const backoffMs = Math.min(attempt * 2000, 10000); // Max 10s
          this.logger.log(`[${key}] Esperando ${backoffMs}ms antes del siguiente intento...`);
          await new Promise(resolve => setTimeout(resolve, backoffMs));
        }
      }
    }
    
    const totalTime = Date.now() - startTime;
    this.logger.error(`[${key}] 💀 DESCARGA FALLÓ después de 3 intentos en ${totalTime}ms:`, lastError);
    throw lastError || new Error('Error desconocido descargando imagen');
  }
  
  private validateImageBuffer(buffer: Buffer): boolean {
    // ENHANCED: Validar magic bytes de imágenes comunes
    if (buffer.length < 8) return false;
    
    const header = buffer.subarray(0, 8);
    
    // JPEG: FF D8 FF
    if (header[0] === 0xFF && header[1] === 0xD8 && header[2] === 0xFF) {
      return true;
    }
    
    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if (header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4E && header[3] === 0x47) {
      return true;
    }
    
    // WebP: 52 49 46 46 ... 57 45 42 50
    if (header[0] === 0x52 && header[1] === 0x49 && header[2] === 0x46 && header[3] === 0x46) {
      return true;
    }
    
    return false;
  }
}