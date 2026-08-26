import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as sharp from 'sharp';
import { createCanvas, registerFont } from 'canvas';
import { join } from 'path';
import { getErrorMessage, getErrorStack } from '@shared/utils';

type GridOptions = {
  width?: number;                 // salida (fit: inside)
  quality?: number;               // calidad JPEG/WebP
  watermarkText?: string;         // texto central
  spacingPct?: number;            // separación entre líneas vs. lado menor (0.06–0.12 típico)
  lineWidthPct?: number;          // grosor vs. lado menor (0.002–0.006 típico)
  dashPct?: number;            // tamaño del dash vs. lado menor (0.02–0.05 típico)
  lineOpacity?: number;           // opacidad líneas (0..1)
  textOpacity?: number;           // opacidad texto (0..1)
  density?: number;               // DPI al rasterizar el SVG
  fontFamily?: string;            // fuente
};

@Injectable()
export class SharpTransformService implements OnModuleInit {
  private readonly logger = new Logger(SharpTransformService.name);

  async onModuleInit() {
    try {
      const fontPath = join(process.cwd(), 'apps', 'api', 'src', 'assets', 'fonts', 'ARIAL.TTF');
      registerFont(fontPath, { family: 'Arial', weight: 'bold' });
      this.logger.log(`Fuente Arial registrada exitosamente desde: ${fontPath}`);
    } catch (error) {
      this.logger.error('CRITICAL: No se pudo registrar la fuente Arial. Las marcas de agua fallarán.', error);
      throw new Error('Failed to register watermark font.');
    }
  }

  // -------------------- THUMBNAIL --------------------
  async generateThumbnail(
    imageBuffer: Buffer,
    options: { width: number; quality: number } = { width: 800, quality: 70 }
  ): Promise<Buffer> {
    try {
      const thumbnailBuffer = await sharp(imageBuffer)
        .resize(options.width, null, { withoutEnlargement: true, fit: 'inside' })
        .jpeg({ quality: options.quality })
        .toBuffer();

      this.logger.debug(`Thumbnail generado: ${thumbnailBuffer.length} bytes`);
      return thumbnailBuffer;
    } catch (error) {
      this.logger.error(`Error generando thumbnail: ${getErrorMessage(error)}`, getErrorStack(error));
      throw error;
    }
  }

  // ===================================================
  // WATERMARK - Canvas-based implementation (más estable que SVG)
  // ===================================================
  async generateWatermark(
    imageBuffer: Buffer,
    options: {
      targetWidth?: number;
      quality?: number;
      watermarkText?: string;
      angleDeg?: number;
      spacingPx?: number;
      fontPx?: number;
      fillOpacity?: number;
      strokeOpacity?: number;
      strokeWidthPx?: number;
    } = {
      targetWidth: 2048,
      quality: 85,
      watermarkText: 'lucilamon.com',
      angleDeg: -32,
      spacingPx: 48,
      fontPx: 20,
      fillOpacity: 0.18,
      strokeOpacity: 0.35,
      strokeWidthPx: 1.0,
    }
  ): Promise<Buffer> {
    try {
      // 1) Obtener dimensiones originales primero
      const originalMeta = await sharp(imageBuffer).metadata();
      if (!originalMeta.width || !originalMeta.height) {
        throw new Error('No se pudieron obtener dimensiones originales');
      }

      // 2) Calcular dimensiones finales después del resize
      const targetWidth = options.targetWidth ?? 2048;
      const aspectRatio = originalMeta.width / originalMeta.height;
      
      let finalWidth = originalMeta.width;
      let finalHeight = originalMeta.height;
      
      // Aplicar la lógica de resize de Sharp
      if (originalMeta.width > targetWidth) {
        finalWidth = targetWidth;
        finalHeight = Math.round(targetWidth / aspectRatio);
      }
      
      // 3) Crear watermark con dimensiones exactas
      const watermarkBuffer = await this.createWatermarkOverlay(finalWidth, finalHeight, options);

      // 4) Procesar imagen base y componer
      const out = await sharp(imageBuffer)
        .rotate()
        .resize(targetWidth, null, { fit: 'inside', withoutEnlargement: true })
        .composite([{ input: watermarkBuffer, blend: 'over' }])
        .jpeg({ quality: options.quality ?? 85 })
        .toBuffer();
  
      this.logger.debug(`Watermark (Canvas-based) OK (${out.length} bytes)`);
      return out;
    } catch (e) {
      this.logger.error(`Watermark error: ${getErrorMessage(e)}`, getErrorStack(e));
      throw new Error(`No se pudo generar una versión protegida: ${getErrorMessage(e)}`);
    }
  }

  async generateSponsoredDownload(
    imageBuffer: Buffer,
    logoBuffers: Buffer[],
    options: { position?: 'top' | 'bottom'; opacity?: number; maxHeightPercent?: number } = {},
  ): Promise<Buffer> {
    if (logoBuffers.length === 0) return imageBuffer;

    const metadata = await sharp(imageBuffer).metadata();
    if (!metadata.width || !metadata.height) throw new Error('No se pudieron leer las dimensiones de la fotografía');
    const swapsAxes = metadata.orientation !== undefined && metadata.orientation >= 5 && metadata.orientation <= 8;
    const imageWidth = swapsAxes ? metadata.height : metadata.width;
    const imageHeight = swapsAxes ? metadata.width : metadata.height;
    const image = sharp(imageBuffer).rotate();

    // La franja se mide contra el ANCHO, no el alto: es lo que la cruza y lo que
    // ordena los logos. Con el alto, una foto vertical de 6000px se llevaba una
    // banda de 780px casi vacía, y la misma escena en horizontal una de 520px.
    const panelHeight = Math.max(90, Math.round(imageWidth * 0.09));
    const logoHeight = Math.max(36, Math.round(panelHeight * 0.62));
    const gap = Math.max(18, Math.round(imageWidth * 0.015));
    const logoCount = Math.min(6, logoBuffers.length);
    const maxLogoWidth = Math.max(40, Math.floor((imageWidth - gap * (logoCount + 1)) / logoCount));
    // Un logo sin canal alfa —un JPEG, lo más habitual— lleva su propio fondo,
    // y sobre la franja oscura se ve como un recorte pegado. Se le pone una
    // tarjeta blanca detrás para que parezca intencionado. El que sí tiene
    // transparencia se compone directo, que es como mejor queda.
    const preparedLogos = await Promise.all(
      logoBuffers.slice(0, 6).map(async buffer => {
        const hasAlpha = Boolean((await sharp(buffer).metadata()).hasAlpha);
        const resized = sharp(buffer).resize({
          width: maxLogoWidth,
          height: hasAlpha ? logoHeight : Math.round(logoHeight * 0.8),
          fit: 'inside',
          withoutEnlargement: true,
        });
        if (hasAlpha) return resized.png().toBuffer();

        const padding = Math.max(6, Math.round(logoHeight * 0.1));
        return sharp(await resized.png().toBuffer())
          .extend({
            top: padding,
            bottom: padding,
            left: padding,
            right: padding,
            background: { r: 255, g: 255, b: 255, alpha: 1 },
          })
          .png()
          .toBuffer();
      }),
    );
    const logoMetadata = await Promise.all(preparedLogos.map(buffer => sharp(buffer).metadata()));
    const totalLogoWidth = logoMetadata.reduce((sum, item) => sum + (item.width || logoHeight), 0) + gap * (preparedLogos.length - 1);
    let cursor = Math.max(gap, Math.round((imageWidth - totalLogoWidth) / 2));
    const top = options.position === 'top' ? 0 : imageHeight - panelHeight;
    // El rótulo también escala: a tamaño fijo era ilegible en una foto de 4000px.
    const captionSize = Math.max(12, Math.round(panelHeight * 0.14));
    const captionY = Math.round(captionSize * 1.6);
    const panel = Buffer.from(
      `<svg width="${imageWidth}" height="${panelHeight}"><rect width="100%" height="100%" fill="rgba(0,0,0,${Math.min(1, Math.max(0.35, options.opacity || 0.82))})"/><text x="${gap}" y="${captionY}" fill="white" font-family="Arial" font-size="${captionSize}" letter-spacing="${Math.round(captionSize * 0.12)}" opacity="0.75">PATROCINADO POR</text></svg>`,
    );
    const composites: sharp.OverlayOptions[] = [{ input: panel, left: 0, top }];
    for (let index = 0; index < preparedLogos.length; index++) {
      const width = logoMetadata[index].width || logoHeight;
      composites.push({
        input: preparedLogos[index],
        left: cursor,
        top: top + captionY + Math.round((panelHeight - captionY - logoHeight) / 2),
      });
      cursor += width + gap;
    }

    return image.composite(composites).jpeg({ quality: 92 }).toBuffer();
  }

  private async createWatermarkOverlay(
    width: number, 
    height: number, 
    options: any
  ): Promise<Buffer> {
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    // Configuración de texto
    // El tamaño se deriva del ancho, no de un valor fijo. Con 20px constantes la
    // marca era casi invisible en una foto de 2048px, y desaparecía del todo en
    // la miniatura, que se compone a tamaño completo y luego se reduce a 800.
    const fontPx = Math.max(12, Math.round(options.fontPx ?? width * 0.022));
    const text = options.watermarkText ?? 'lucilamon.com';
    const spacing = Math.max(12, Math.round(options.spacingPx ?? fontPx * 3.2));
    const angle = (options.angleDeg ?? -32) * Math.PI / 180; // Convertir a radianes

    // CRITICAL FIX: Usar la fuente pre-registrada
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = `bold ${fontPx}px Arial`;

    // Validar que la fuente pre-registrada funciona
    const testWidth = ctx.measureText('A').width;
    if (testWidth <= 0) {
      this.logger.error(`CRITICAL: La fuente pre-registrada 'Arial' no se pudo usar. Canvas/font system failure.`);
      throw new Error(`La fuente pre-registrada 'Arial' no se pudo usar.`);
    }
    this.logger.debug(`Fuente pre-registrada 'Arial' validada con éxito (testWidth: ${testWidth})`);

    // Colores con opacidad
    const fillOpacity = Math.min(1, Math.max(0, options.fillOpacity ?? 0.26));
    const strokeOpacity = Math.min(1, Math.max(0, options.strokeOpacity ?? 0.3));
    // El contorno también escala: a 1px fijo no sostenía una letra grande.
    const strokeWidth = Math.max(0.5, options.strokeWidthPx ?? fontPx * 0.045);

    ctx.fillStyle = `rgba(255, 255, 255, ${fillOpacity})`;
    ctx.strokeStyle = `rgba(0, 0, 0, ${strokeOpacity})`;
    ctx.lineWidth = strokeWidth;

    // Calcular dimensiones rotadas para cubrir toda la imagen
    const diagonal = Math.sqrt(width * width + height * height);
    let textWidth = ctx.measureText(text).width;
    
    // CRITICAL FIX: Validar que measureText funciona correctamente
    if (textWidth <= 0) {
      // Fallback si measureText falla - usar aproximación
      textWidth = text.length * fontPx * 0.6;
      this.logger.warn(`measureText falló, usando fallback: ${textWidth}px para "${text}"`);
    }
    const textSpacing = textWidth + fontPx * 1.6;

    // Guardar estado y aplicar transformación
    ctx.save();
    ctx.translate(width / 2, height / 2);
    ctx.rotate(angle);

    // Dibujar patrón de texto
    const startX = -diagonal;
    const endX = diagonal;
    const startY = -diagonal;
    const endY = diagonal;

    for (let y = startY; y < endY; y += spacing) {
      for (let x = startX; x < endX; x += textSpacing) {
        // Font ya está cargado y validado arriba - no necesitamos reconfigurar
        
        // Dibujar borde (stroke) primero
        if (strokeOpacity > 0) {
          ctx.strokeText(text, x, y);
        }
        // Luego el relleno
        if (fillOpacity > 0) {
          ctx.fillText(text, x, y);
        }
      }
    }

    ctx.restore();

    // Convertir canvas a buffer PNG
    const pngBuffer = canvas.toBuffer('image/png');
    
    // CRITICAL FIX: Validar que el buffer no esté corrupto
    if (pngBuffer.length < 100) {
      throw new Error(`Watermark PNG demasiado pequeño: ${pngBuffer.length} bytes - posible corrupción`);
    }
    
    this.logger.debug(`Watermark overlay generado: ${pngBuffer.length} bytes, dimensiones: ${width}x${height}`);
    return pngBuffer;
  }
  

  // -------------------- OCR --------------------
  async optimizeForOCR(
    imageBuffer: Buffer,
    options: { width: number; quality: number } = { width: 3000, quality: 90 }
  ): Promise<Buffer> {
    try {
      const optimizedBuffer = await sharp(imageBuffer)
        .resize(options.width, null, { withoutEnlargement: true, fit: 'inside' })
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

  // -------------------- METADATA --------------------
  async getImageMetadata(imageBuffer: Buffer): Promise<{ width: number; height: number; format: string; size: number; hasAlpha: boolean }> {
    try {
      const metadata = await sharp(imageBuffer).metadata();
      return {
        width: metadata.width || 0,
        height: metadata.height || 0,
        format: metadata.format || 'unknown',
        size: metadata.size || imageBuffer.length,
        hasAlpha: Boolean(metadata.hasAlpha),
      };
    } catch (error) {
      this.logger.error(`Error obteniendo metadatos: ${getErrorMessage(error)}`, getErrorStack(error));
      throw error;
    }
  }

  // -------------------- RESIZE --------------------
  async resizeImage(
    imageBuffer: Buffer,
    width?: number,
    height?: number,
    options: { quality?: number; format?: 'jpeg' | 'png' | 'webp' } = {}
  ): Promise<Buffer> {
    try {
      let pipeline = sharp(imageBuffer);

      if (width || height) {
        pipeline = pipeline.resize(width, height, { withoutEnlargement: true, fit: 'inside' });
      }

      const format = options.format || 'jpeg';
      const quality = options.quality || 80;

      switch (format) {
        case 'jpeg': pipeline = pipeline.jpeg({ quality }); break;
        case 'png':  pipeline = pipeline.png({ quality });  break;
        case 'webp': pipeline = pipeline.webp({ quality }); break;
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
