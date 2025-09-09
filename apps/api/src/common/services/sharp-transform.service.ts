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
      opacity: 0.8 
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

      // Crear múltiples marcas de agua más visibles
      const fontSize = Math.max(24, Math.floor(width / 40)); // Más grande para mayor visibilidad
      const svgWidth = Math.floor(width / 4); // Más grande para texto más visible
      const svgHeight = Math.floor(height / 5); // Más grande para texto más visible
      const cols = 3; // 3 columnas (menos marcas pero más grandes)
      const rows = 4; // 4 filas = 12 marcas de agua total
      const spacingX = Math.floor(width / cols);
      const spacingY = Math.floor(height / rows);
      
      const watermarkElements = [];
      
      // Crear grid de marcas de agua con márgenes
      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const x = Math.floor(col * spacingX + spacingX * 0.2); // 20% de margen
          const y = Math.floor(row * spacingY + spacingY * 0.3); // 30% de margen
          
          // Alternar horizontal y diagonal
          const isRotated = (row + col) % 2 === 1;
          const rotation = isRotated ? -45 : 0;
          const opacity = isRotated ? 0.9 : 1.0; // Más opaco para mayor visibilidad
          
          // SVG ajustado al espacio disponible con texto más grueso
          const textSvg = Buffer.from(`
            <svg width="${svgWidth}" height="${svgHeight}" xmlns="http://www.w3.org/2000/svg">
              <text x="50%" y="50%" 
                    font-family="Arial, sans-serif" 
                    font-size="${fontSize}" 
                    font-weight="900"
                    stroke="rgba(0,0,0,${opacity * 0.3})"
                    stroke-width="2"
                    fill="rgba(255,255,255,${opacity})" 
                    text-anchor="middle"
                    dominant-baseline="middle"
                    transform="rotate(${rotation} ${svgWidth/2} ${svgHeight/2})">${options.watermarkText}</text>
            </svg>
          `);
          
          watermarkElements.push({
            input: textSvg,
            left: Math.min(width - svgWidth, x),
            top: Math.min(height - svgHeight, y),
            blend: 'over',
          });
        }
      }

      const watermarkedBuffer = await resized
        .composite(watermarkElements)
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