import { Injectable, Logger } from '@nestjs/common';
import * as sharp from 'sharp';
import { getErrorMessage, getErrorStack } from '@shared/utils';

type GridOptions = {
  width?: number;                 // salida (fit: inside)
  quality?: number;               // calidad JPEG/WebP
  watermarkText?: string;         // texto central
  spacingPct?: number;            // separación entre líneas vs. lado menor (0.06–0.12 típico)
  lineWidthPct?: number;          // grosor vs. lado menor (0.002–0.006 típico)
  dashPct?: number;               // tamaño del dash vs. lado menor (0.02–0.05 típico)
  lineOpacity?: number;           // opacidad líneas (0..1)
  textOpacity?: number;           // opacidad texto (0..1)
  density?: number;               // DPI al rasterizar el SVG
  fontFamily?: string;            // fuente
};

@Injectable()
export class SharpTransformService {
  private readonly logger = new Logger(SharpTransformService.name);

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
  // WATERMARK (nombre original) -> líneas diagonales + texto central
  // ===================================================
  async generateWatermark(
    imageBuffer: Buffer,
    options: {
      width?: number;
      quality?: number;
      watermarkText?: string;
      spacingPct?: number;
      lineWidthPct?: number;
      dashPct?: number;
      lineOpacity?: number;
      textOpacity?: number;
      fontFamily?: string;
    } = {
      width: 2000,
      quality: 85,
      watermarkText: 'fotocorredor.com',
      spacingPct: 0.09,
      lineWidthPct: 0.003,
      dashPct: 0.035,
      lineOpacity: 0.55,
      textOpacity: 0.35,
      fontFamily: 'DejaVu Sans, sans-serif',
    }
  ): Promise<Buffer> {
    try {
      const base = sharp(imageBuffer)
        .rotate()
        .resize(options.width ?? 2000, null, { fit: 'inside', withoutEnlargement: true });
  
      const { width = 0, height = 0 } = await base.metadata();
      if (!width || !height) throw new Error('No se pudieron obtener dimensiones');
  
      const side    = Math.min(width, height);
      const spacing = Math.max(20, Math.round(side * (options.spacingPct ?? 0.09)));
      const lineW   = Math.max(1,  Math.round(side * (options.lineWidthPct ?? 0.003)));
      const dashLen = Math.max(6,  Math.round(side * (options.dashPct ?? 0.035)));
  
      // Texto central proporcional
      const fontSize = Math.max(24, Math.round(side * 0.055));
      const font     = options.fontFamily ?? 'DejaVu Sans, sans-serif';
  
      const lines: string[] = [];
      const stroke       = `stroke="#FFFFFF" stroke-opacity="${options.lineOpacity ?? 0.55}" stroke-width="${lineW}" stroke-linecap="round"`;
      const strokeShadow = `stroke="#000000" stroke-opacity="${(options.lineOpacity ?? 0.55) * 0.45}" stroke-width="${lineW + 1.2}" stroke-linecap="round"`;
  
      // / (izq-abajo -> der-arriba)
      for (let o = -height; o <= width; o += spacing) {
        const x1 = Math.max(0, o);
        const y1 = Math.max(0, -o);
        const x2 = Math.min(width, o + height);
        const y2 = Math.min(height, height - Math.max(0, o + height - width));
        lines.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" ${strokeShadow} stroke-dasharray="${dashLen},${dashLen}"/>`);
        lines.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" ${stroke}       stroke-dasharray="${dashLen},${dashLen}"/>`);
      }
  
      // \ (izq-arriba -> der-abajo)
      for (let o = 0; o <= width + height; o += spacing) {
        const x1 = Math.max(0, o - height);
        const y1 = Math.max(0, o - width);
        const x2 = Math.min(width, o);
        const y2 = Math.min(height, o);
        lines.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" ${strokeShadow} stroke-dasharray="${dashLen},${dashLen}"/>`);
        lines.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" ${stroke}       stroke-dasharray="${dashLen},${dashLen}"/>`);
      }
  
      const text = options.watermarkText ?? 'fotocorredor.com';
      const textStroke = Math.max(1, Math.round(fontSize * 0.08));
      const centerText = `
        <g transform="translate(${width / 2}, ${height / 2})">
          <text x="0" y="0"
                font-family="${font}"
                font-size="${fontSize}"
                font-weight="800"
                text-anchor="middle"
                dominant-baseline="middle"
                fill="#FFFFFF" fill-opacity="${options.textOpacity ?? 0.35}"
                stroke="#000000" stroke-opacity="${(options.textOpacity ?? 0.35) * 0.7}"
                stroke-width="${textStroke}">
            ${this.escapeXml(text)}
          </text>
        </g>
      `;
  
      // ⚠️ Ojo: hacemos el SVG un pelín más chico para evitar off-by-one
      const svgW = Math.max(1, width  - 2);
      const svgH = Math.max(1, height - 2);
  
      const svg = `
        <svg xmlns="http://www.w3.org/2000/svg" width="${svgW}" height="${svgH}">
          <g>${lines.join('')}</g>
          ${centerText}
        </svg>
      `;
  
      // 1) Rasteriza SIN density (cuando hay width/height en px no hace falta)
      let overlay = await sharp(Buffer.from(svg))
        .png()
        .toBuffer();
  
      // 2) Clamp defensivo por si el raster quedara 1–2 px más grande
      const om = await sharp(overlay).metadata();
      if ((om.width ?? Infinity) > width || (om.height ?? Infinity) > height) {
        overlay = await sharp(overlay)
          .resize(width, height, { fit: 'inside', withoutEnlargement: true })
          .toBuffer();
      }
  
      const out = await base
        .composite([{ input: overlay, left: 0, top: 0, blend: 'over' }])
        .jpeg({ quality: options.quality ?? 85 })
        .toBuffer();
  
      this.logger.debug(`Watermark (grid+center) OK (${out.length} bytes)`);
      return out;
    } catch (e) {
      this.logger.error(`Watermark error: ${getErrorMessage(e)}`, getErrorStack(e));
      // Fallback sin watermark
      return sharp(imageBuffer)
        .rotate()
        .resize(options.width ?? 2000, null, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: options.quality ?? 85 })
        .toBuffer();
    }
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

  // -------------------- Helpers SVG --------------------
  private escapeXml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }
}
