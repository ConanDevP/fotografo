import { Injectable, Logger } from '@nestjs/common';
import { StorageService } from '../../../api/src/common/services/storage.service';

@Injectable()
export class ImagesService {
  private readonly logger = new Logger(ImagesService.name);

  constructor(private storageService: StorageService) {}

  async generateDerivatives(cloudinaryId: string, eventId: string, photoId: string) {
    try {
      this.logger.log(`Generando derivados para foto ${photoId}`);

      // Generate thumbnail and watermark in parallel
      const [thumbUrl, watermarkUrl] = await Promise.all([
        this.storageService.generateThumbnail(cloudinaryId, eventId, photoId),
        this.storageService.generateWatermark(cloudinaryId, eventId, photoId),
      ]);

      this.logger.log(`Derivados generados para ${photoId}`);

      return {
        thumbUrl,
        watermarkUrl,
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