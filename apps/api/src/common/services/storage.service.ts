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

  async generateThumbnail(cloudinaryId: string, eventId: string, photoId: string): Promise<string> {
    if (this.provider === 'r2') {
      // Con R2, descargamos la imagen original, generamos thumbnail con Sharp y subimos
      try {
        const originalKey = cloudinaryId; // En R2, cloudinaryId es el key
        const thumbnailKey = `events/${eventId}/thumb/${photoId}.jpg`;
        
        // Obtenemos la imagen original
        const originalBuffer = await this.getImageBuffer(originalKey);
        
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
        
        // Obtenemos la imagen original
        const originalBuffer = await this.getImageBuffer(originalKey);
        
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

  private async getImageBuffer(key: string): Promise<Buffer> {
    // Método auxiliar para obtener buffer de imagen desde R2
    const url = await this.r2Service.generateSecureDownloadUrl(key, 60); // 1 minuto para uso interno
    const response = await fetch(url);
    
    if (!response.ok) {
      throw new Error(`Error descargando imagen: ${response.statusText}`);
    }
    
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }
}