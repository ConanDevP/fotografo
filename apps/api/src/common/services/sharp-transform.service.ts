import { Injectable, Logger } from '@nestjs/common';
import * as sharp from 'sharp';
import { getErrorMessage, getErrorStack } from '@shared/utils';

@Injectable()
export class SharpTransformService {
  private readonly logger = new Logger(SharpTransformService.name);

  async generateThumbnail(
    imageBuffer: Buffer,
    options: { width: number; quality: number } = { width: 800, quality: 70 }
  ): Promise<Buffer> {
    try {
      const thumbnailBuffer = await sharp(imageBuffer)
        .resize(options.width, null, {
          withoutEnlargement: true,
          fit: 'inside',
        })
        .jpeg({ quality: options.quality })
        .toBuffer();

      this.logger.debug(`Thumbnail generado: ${thumbnailBuffer.length} bytes`);
      return thumbnailBuffer;
    } catch (error) {
      this.logger.error(`Error generando thumbnail: ${getErrorMessage(error)}`, getErrorStack(error));
      throw error;
    }
  }

  async generateWatermark(
    imageBuffer: Buffer,
    options: { 
      width: number; 
      quality: number; 
      watermarkText: string;
      opacity: number;
    } = { 
      width: 2000, 
      quality: 80, 
      watermarkText: '© Fotografo', 
      opacity: 0.3 
    }
  ): Promise<Buffer> {
    try {
      // Por ahora, simplemente redimensionamos sin watermark para evitar errores
      // TODO: Implementar watermark con overlay de imagen en lugar de SVG
      const watermarkedBuffer = await sharp(imageBuffer)
        .resize(options.width, null, {
          withoutEnlargement: true,
          fit: 'inside',
        })
        .jpeg({ quality: options.quality })
        .toBuffer();

      this.logger.debug(`Watermark generado (sin texto por compatibilidad): ${watermarkedBuffer.length} bytes`);
      return watermarkedBuffer;
    } catch (error) {
      this.logger.error(`Error generando watermark: ${getErrorMessage(error)}`, getErrorStack(error));
      throw error;
    }
  }

  async optimizeForOCR(
    imageBuffer: Buffer,
    options: { width: number; quality: number } = { width: 3000, quality: 90 }
  ): Promise<Buffer> {
    try {
      const optimizedBuffer = await sharp(imageBuffer)
        .resize(options.width, null, {
          withoutEnlargement: true,
          fit: 'inside',
        })
        .sharpen()
        .normalize()
        .jpeg({ quality: options.quality })
        .toBuffer();

      this.logger.debug(`Imagen optimizada para OCR: ${optimizedBuffer.length} bytes`);
      return optimizedBuffer;
    } catch (error) {
      this.logger.error(`Error optimizando para OCR: ${getErrorMessage(error)}`, getErrorStack(error));
      throw error;
    }
  }

  async getImageMetadata(imageBuffer: Buffer): Promise<{ width: number; height: number; format: string; size: number }> {
    try {
      const metadata = await sharp(imageBuffer).metadata();
      
      return {
        width: metadata.width || 0,
        height: metadata.height || 0,
        format: metadata.format || 'unknown',
        size: metadata.size || imageBuffer.length,
      };
    } catch (error) {
      this.logger.error(`Error obteniendo metadatos: ${getErrorMessage(error)}`, getErrorStack(error));
      throw error;
    }
  }

  async resizeImage(
    imageBuffer: Buffer,
    width?: number,
    height?: number,
    options: { quality?: number; format?: 'jpeg' | 'png' | 'webp' } = {}
  ): Promise<Buffer> {
    try {
      let pipeline = sharp(imageBuffer);

      if (width || height) {
        pipeline = pipeline.resize(width, height, {
          withoutEnlargement: true,
          fit: 'inside',
        });
      }

      const format = options.format || 'jpeg';
      const quality = options.quality || 80;

      switch (format) {
        case 'jpeg':
          pipeline = pipeline.jpeg({ quality });
          break;
        case 'png':
          pipeline = pipeline.png({ quality });
          break;
        case 'webp':
          pipeline = pipeline.webp({ quality });
          break;
      }

      const resultBuffer = await pipeline.toBuffer();
      this.logger.debug(`Imagen redimensionada: ${resultBuffer.length} bytes`);
      
      return resultBuffer;
    } catch (error) {
      this.logger.error(`Error redimensionando imagen: ${getErrorMessage(error)}`, getErrorStack(error));
      throw error;
    }
  }
}