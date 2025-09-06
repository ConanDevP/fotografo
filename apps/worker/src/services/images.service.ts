import { Injectable, Logger } from '@nestjs/common';
import { CloudinaryService } from '../../../api/src/common/services/cloudinary.service';

@Injectable()
export class ImagesService {
  private readonly logger = new Logger(ImagesService.name);

  constructor(private cloudinaryService: CloudinaryService) {}

  async generateDerivatives(cloudinaryId: string, eventId: string, photoId: string) {
    try {
      this.logger.log(`Generando derivados para foto ${photoId}`);

      // Generate thumbnail and watermark in parallel
      const [thumbUrl, watermarkUrl] = await Promise.all([
        this.cloudinaryService.generateThumbnail(cloudinaryId, eventId, photoId),
        this.cloudinaryService.generateWatermark(cloudinaryId, eventId, photoId),
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
    return this.cloudinaryService.getOptimizedUrlForOCR(cloudinaryId);
  }
}