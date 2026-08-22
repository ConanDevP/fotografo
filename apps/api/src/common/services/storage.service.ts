import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CloudinaryService } from './cloudinary.service';
import { R2Service } from './r2.service';
import { SharpTransformService } from './sharp-transform.service';
import { lookup } from 'dns/promises';

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

  async uploadAvatar(file: Express.Multer.File, userId: string): Promise<{ key: string; url: string }> {
    if (this.provider === 'r2') return this.r2Service.uploadAvatar(file, userId);
    const result = await this.cloudinaryService.uploadImage(
      file.buffer,
      `avatars/${userId}/avatar`,
      { width: 512, height: 512, crop: 'fill' },
    );
    return { key: result.public_id, url: result.secure_url };
  }

  async getImageMetadata(buffer: Buffer) {
    return this.sharpService.getImageMetadata(buffer);
  }

  async prepareFaceSearchImage(buffer: Buffer) {
    const metadata = await this.sharpService.getImageMetadata(buffer);
    const allowedFormats = new Set(['jpeg', 'png', 'webp']);
    if (
      !allowedFormats.has(metadata.format)
      || !metadata.width
      || !metadata.height
      || metadata.width * metadata.height > 20_000_000
    ) {
      throw new Error('La selfie no es una imagen válida o excede 20 megapíxeles');
    }
    return this.sharpService.resizeImage(buffer, 2048, 2048, { quality: 88, format: 'jpeg' });
  }

  async uploadPrivateTemporaryImage(buffer: Buffer, key: string) {
    if (this.provider === 'r2') return this.r2Service.uploadPrivateImage(buffer, key, 'image/jpeg');
    return this.cloudinaryService.uploadPrivateImage(buffer, key);
  }

  private imageBufferCache = new Map<string, Promise<Buffer>>();
  private downloadMutex = new Map<string, Promise<void>>();

  // ── Subida directa del navegador a R2 ──────────────────────────────────
  //
  // Con estas tres piezas el archivo nunca pasa por la memoria del servidor:
  // se firma la URL, el navegador escribe en R2, y después se comprueba qué
  // quedó realmente almacenado. Solo existe para R2; Cloudinary no participa.

  private assertDirectUploadSupported() {
    if (this.provider !== 'r2') {
      throw new Error(
        `La subida directa requiere STORAGE_PROVIDER=r2 (actual: ${this.provider})`,
      );
    }
  }

  async createUploadUrl(key: string, contentType: string, expiresIn = 3600) {
    this.assertDirectUploadSupported();
    return this.r2Service.generateUploadUrl(key, contentType, expiresIn);
  }

  async headUploadedPhoto(key: string) {
    this.assertDirectUploadSupported();
    return this.r2Service.headPhoto(key);
  }

  async readUploadedHead(key: string, bytes = 16) {
    this.assertDirectUploadSupported();
    return this.r2Service.readHead(key, bytes);
  }

  /**
   * Genera la miniatura y devuelve su tamaño para poder contabilizarlo en el
   * consumo del espacio. Con Cloudinary los bytes no son visibles desde aquí,
   * así que se informa `null` en vez de inventar una cifra.
   */
  async generateThumbnail(
    cloudinaryId: string,
    eventId: string,
    photoId: string,
  ): Promise<{ url: string; bytes: number | null }> {
    if (this.provider === 'r2') {
      try {
        const originalKey = cloudinaryId;
        const thumbnailKey = `events/${eventId}/thumb/${photoId}.jpg`;
        const originalBuffer = await this.getCachedImageBuffer(originalKey);
        const thumbnailBuffer = await this.sharpService.generateThumbnail(originalBuffer);
        const thumbnailUrl = await this.r2Service.uploadImage(thumbnailBuffer, thumbnailKey);
        this.logger.log(`Thumbnail generado en R2: ${thumbnailKey}`);
        return { url: thumbnailUrl, bytes: thumbnailBuffer.byteLength };
      } catch (error) {
        this.logger.error(`Error generando thumbnail en R2:`, error);
        throw error;
      }
    }

    const url = await this.cloudinaryService.generateThumbnail(cloudinaryId, eventId, photoId);
    return { url, bytes: null };
  }

  async generateWatermark(
    cloudinaryId: string,
    eventId: string,
    photoId: string,
    watermarkText = 'lucilamon.com',
  ): Promise<{ url: string; bytes: number | null }> {
    if (this.provider === 'r2') {
      try {
        const originalKey = cloudinaryId;
        const watermarkKey = `events/${eventId}/wm/${photoId}.jpg`;
        const originalBuffer = await this.getCachedImageBuffer(originalKey);
        const watermarkBuffer = await this.sharpService.generateWatermark(originalBuffer, { watermarkText });
        const watermarkUrl = await this.r2Service.uploadImage(watermarkBuffer, watermarkKey);
        this.logger.log(`Watermark generado en R2: ${watermarkKey}`);
        return { url: watermarkUrl, bytes: watermarkBuffer.byteLength };
      } catch (error) {
        this.logger.error(`Error generando watermark en R2:`, error);
        throw error;
      }
    }

    const url = await this.cloudinaryService.generateWatermark(cloudinaryId, eventId, photoId);
    return { url, bytes: null };
  }

  /**
   * Miniatura CON marca de agua, la única versión pequeña que puede servirse
   * públicamente. Se compone del original y luego se reduce, para que la marca
   * quede proporcionada en la imagen final.
   */
  async generateWatermarkThumbnail(
    cloudinaryId: string,
    eventId: string,
    photoId: string,
    watermarkText = 'lucilamon.com',
  ): Promise<{ url: string; bytes: number | null }> {
    if (this.provider !== 'r2') return { url: '', bytes: null };
    const key = `events/${eventId}/wm-thumb/${photoId}.jpg`;
    const originalBuffer = await this.getCachedImageBuffer(cloudinaryId);
    const watermarked = await this.sharpService.generateWatermark(originalBuffer, { watermarkText });
    const small = await this.sharpService.resizeImage(watermarked, 800, 800, { quality: 72, format: 'jpeg' });
    const url = await this.r2Service.uploadImage(small, key);
    this.logger.log(`Miniatura con marca generada en R2: ${key}`);
    return { url, bytes: small.byteLength };
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

  async generateSponsoredAsset(
    cloudinaryId: string,
    eventId: string,
    photoId: string,
    sponsorSignature: string,
    sponsors: Array<{ logoUrl: string; placement?: any }>,
  ): Promise<{ storageKey: string; url: string }> {
    const originalBuffer = this.provider === 'r2'
      ? await this.getCachedImageBuffer(cloudinaryId)
      : await this.downloadBuffer(await this.generateSecureDownloadUrl(cloudinaryId, 900), 60 * 1024 * 1024);
    const logoBuffers = await Promise.all(
      sponsors.slice(0, 6).map(sponsor => this.downloadBuffer(sponsor.logoUrl, 3 * 1024 * 1024)),
    );
    const logoMetadata = await Promise.all(logoBuffers.map(buffer => this.sharpService.getImageMetadata(buffer)));
    if (logoMetadata.some(item => !['jpeg', 'png', 'webp'].includes(item.format) || !item.width || !item.height || item.width * item.height > 20_000_000)) {
      throw new Error('Uno de los logos no es una imagen JPG, PNG o WEBP válida');
    }
    const placement = sponsors[0]?.placement || {};
    const output = await this.sharpService.generateSponsoredDownload(originalBuffer, logoBuffers, placement);
    const storageKey = `events/${eventId}/downloads/${photoId}-${sponsorSignature}.jpg`;
    if (this.provider === 'r2') {
      const upload = await this.r2Service.uploadPrivateImage(output, storageKey);
      return { storageKey: upload.key, url: upload.url };
    }
    const upload = await this.cloudinaryService.uploadPrivateImage(output, storageKey);
    return { storageKey: upload.key, url: upload.url };
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

  private async downloadBuffer(url: string, maxBytes: number, redirectCount = 0): Promise<Buffer> {
    if (redirectCount > 3) throw new Error('El recurso tiene demasiadas redirecciones');
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('Solo se permiten recursos HTTPS públicos');
    const addresses = await lookup(parsed.hostname, { all: true });
    if (addresses.length === 0 || addresses.some(({ address }) => this.isPrivateAddress(address))) {
      throw new Error('El recurso apunta a una red privada o reservada');
    }
    const response = await fetch(url, { signal: AbortSignal.timeout(20_000), redirect: 'manual' });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new Error('La redirección del recurso no es válida');
      return this.downloadBuffer(new URL(location, url).toString(), maxBytes, redirectCount + 1);
    }
    if (!response.ok) throw new Error(`No se pudo descargar el recurso (${response.status})`);
    const contentLength = Number(response.headers.get('content-length') || 0);
    if (contentLength > maxBytes) throw new Error('El recurso excede el tamaño permitido');
    const reader = response.body?.getReader();
    if (!reader) throw new Error('El recurso no contiene datos');
    const chunks: Buffer[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error('El recurso excede el tamaño permitido');
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  }

  private isPrivateAddress(address: string) {
    const normalized = address.toLowerCase();
    if (normalized.includes(':') && !normalized.startsWith('::ffff:')) {
      // Only globally routable IPv6 unicast (2000::/3) is accepted.
      return !(normalized.startsWith('2') || normalized.startsWith('3'));
    }
    if (normalized === '::1' || normalized === '::') {
      return true;
    }
    const ipv4 = normalized.startsWith('::ffff:') ? normalized.slice(7) : normalized;
    const parts = ipv4.split('.').map(Number);
    if (parts.length !== 4 || parts.some(Number.isNaN)) return false;
    const [a, b, c] = parts;
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || b === 2))
      || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
      || (a === 203 && b === 0 && c === 113);
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
