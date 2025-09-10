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

  private imageBufferCache = new Map<string, Promise<Buffer>>();
  private downloadMutex = new Map<string, Promise<void>>();

  async generateThumbnail(cloudinaryId: string, eventId: string, photoId: string): Promise<string> {
    if (this.provider === 'r2') {
      try {
        const originalKey = cloudinaryId;
        const thumbnailKey = `events/${eventId}/thumb/${photoId}.jpg`;
        const originalBuffer = await this.getCachedImageBuffer(originalKey);
        const thumbnailBuffer = await this.sharpService.generateThumbnail(originalBuffer);
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
        const originalBuffer = await this.getCachedImageBuffer(originalKey);
        const watermarkBuffer = await this.sharpService.generateWatermark(originalBuffer);
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
    if (this.downloadMutex.has(key)) {
      await this.downloadMutex.get(key)!;
    }

    if (this.imageBufferCache.has(key)) {
      const cachedPromise = this.imageBufferCache.get(key)!;
      return Buffer.from(await cachedPromise);
    }

    let resolveMutex: () => void;
    const mutexPromise = new Promise<void>(resolve => { resolveMutex = resolve; });
    this.downloadMutex.set(key, mutexPromise);

    try {
      this.logger.log(`Iniciando download exclusivo para: ${key}`);
      const downloadPromise = this.getImageBuffer(key);
      this.imageBufferCache.set(key, downloadPromise);

      const buffer = await downloadPromise;

      setTimeout(() => {
        this.imageBufferCache.delete(key);
        this.logger.debug(`Cache limpiado para: ${key}`);
      }, 5 * 60 * 1000);

      return Buffer.from(buffer);
    } finally {
      this.downloadMutex.delete(key);
      resolveMutex!();
    }
  }

  private async getImageBuffer(key: string): Promise<Buffer> {
    let lastError: Error | undefined;
    const startTime = Date.now();
    
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        this.logger.log(`[${key}] Descargando (Intento ${attempt}/3)...`);
        const url = await this.r2Service.generateSecureDownloadUrl(key, 900);
        const response = await fetch(url, {
          headers: { 'User-Agent': 'Node.js/ImageDownloader' },
          signal: AbortSignal.timeout(30000)
        });
        
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        
        if (buffer.length < 1000) throw new Error(`Buffer muy pequeño: ${buffer.length} bytes`);
        
        if (!this.validateImageBuffer(buffer)) throw new Error(`Buffer no es una imagen válida para ${key}`);
        
        const downloadTime = Date.now() - startTime;
        this.logger.log(`[${key}] ✅ Descarga exitosa: ${buffer.length} bytes en ${downloadTime}ms`);
        return buffer;
        
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        const attemptTime = Date.now() - startTime;
        this.logger.warn(`[${key}] ❌ Intento ${attempt}/3 falló en ${attemptTime}ms: ${lastError.message}`);
        if (attempt < 3) {
          const backoffMs = Math.min(attempt * 2000, 10000);
          await new Promise(resolve => setTimeout(resolve, backoffMs));
        }
      }
    }
    
    const totalTime = Date.now() - startTime;
    this.logger.error(`[${key}] 💀 DESCARGA FALLÓ después de 3 intentos en ${totalTime}ms:`, lastError);
    throw lastError || new Error('Error desconocido descargando imagen');
  }
  
  private validateImageBuffer(buffer: Buffer): boolean {
    if (buffer.length < 8) return false;
    const header = buffer.subarray(0, 8);
    if (header[0] === 0xFF && header[1] === 0xD8 && header[2] === 0xFF) return true; // JPEG
    if (header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4E && header[3] === 0x47) return true; // PNG
    if (header[0] === 0x52 && header[1] === 0x49 && header[2] === 0x46 && header[3] === 0x46) return true; // WebP
    return false;
  }
}