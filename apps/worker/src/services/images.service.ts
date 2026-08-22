import { Injectable, Logger } from '@nestjs/common';
import { StorageService } from '../../../api/src/common/services/storage.service';

@Injectable()
export class ImagesService {
  private readonly logger = new Logger(ImagesService.name);

  constructor(private storageService: StorageService) {}

  async generateDerivatives(cloudinaryId: string, eventId: string, photoId: string, watermarkText = 'lucilamon.com') {
    try {
      this.logger.log(`Generando derivados para foto ${photoId}`);

      // Generate thumbnail and watermark in parallel
      const [thumb, watermark, watermarkThumb] = await Promise.all([
        this.storageService.generateThumbnail(cloudinaryId, eventId, photoId),
        this.storageService.generateWatermark(cloudinaryId, eventId, photoId, watermarkText),
        this.storageService.generateWatermarkThumbnail(cloudinaryId, eventId, photoId, watermarkText),
      ]);

      this.logger.log(`Derivados generados para ${photoId}`);

      // Suma de bytes de las derivadas para el medidor de almacenamiento. Es
      // null cuando el proveedor no expone el tamaño, para no contabilizar de más.
      const derivedBytes =
        thumb.bytes === null && watermark.bytes === null
          ? null
          : (thumb.bytes ?? 0) + (watermark.bytes ?? 0) + (watermarkThumb.bytes ?? 0);

      return {
        thumbUrl: thumb.url,
        watermarkUrl: watermark.url,
        watermarkThumbUrl: watermarkThumb.url || null,
        derivedBytes,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Error desconocido';
      const errorStack = error instanceof Error ? error.stack : undefined;
      this.logger.error(`Error generando derivados: ${errorMessage}`, errorStack);
      throw error;
    }
  }

  async getOptimizedImageForOCR(cloudinaryId: string): Promise<string> {
    return this.storageService.getOptimizedUrlForOCR(cloudinaryId);
  }
}
