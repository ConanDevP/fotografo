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
      watermarkText: 'fotocorredor.com', 
      opacity: 0.3 
    }
  ): Promise<Buffer> {
    try {
      // Crear un watermark simple con canvas-like approach usando Sharp
      const resized = sharp(imageBuffer)
        .resize(options.width, null, {
          withoutEnlargement: true,
          fit: 'inside',
        });

      const { width, height } = await resized.metadata();
      
      if (!width || !height) {
        throw new Error('No se pudieron obtener las dimensiones de la imagen');
      }

      // Crear una imagen de texto simple usando Sharp
      const fontSize = Math.max(40, Math.floor(width / 20));
      const textWidth = options.watermarkText.length * fontSize * 0.6;
      const textHeight = fontSize + 20;
      
      // Crear SVG con dimensiones exactas
      const svgWatermark = Buffer.from(`
        <svg width="${textWidth}" height="${textHeight}" xmlns="http://www.w3.org/2000/svg">
          <rect width="100%" height="100%" fill="none"/>
          <text x="50%" y="60%" 
                font-family="Arial, sans-serif" 
                font-size="${fontSize}" 
                font-weight="bold"
                fill="rgba(255,255,255,${options.opacity})" 
                text-anchor="middle">${options.watermarkText}</text>
        </svg>
      `);

      // Posición en la esquina inferior derecha (enteros)
      const left = Math.max(0, Math.floor(width - textWidth - 20));
      const top = Math.max(0, Math.floor(height - textHeight - 20));

      const watermarkedBuffer = await resized
        .composite([{
          input: svgWatermark,
          left: left,
          top: top,
          blend: 'over',
        }])
        .jpeg({ quality: options.quality })
        .toBuffer();

      this.logger.debug(`Watermark '${options.watermarkText}' generado: ${watermarkedBuffer.length} bytes`);
      return watermarkedBuffer;
    } catch (error) {
      this.logger.error(`Error generando watermark: ${getErrorMessage(error)}`, getErrorStack(error));
      
      // Fallback: solo redimensionar si el watermark falla
      const fallbackBuffer = await sharp(imageBuffer)
        .resize(options.width, null, {
          withoutEnlargement: true,
          fit: 'inside',
        })
        .jpeg({ quality: options.quality })
        .toBuffer();

      this.logger.warn(`Watermark fallback aplicado: ${fallbackBuffer.length} bytes`);
      return fallbackBuffer;
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