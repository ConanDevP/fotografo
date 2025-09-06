import { Injectable, Logger } from '@nestjs/common';
import { CloudinaryService } from './cloudinary.service';
import { getErrorMessage } from '@shared/utils';

interface PhotoWithBibs {
  photoId: string;
  eventId: string;
  cloudinaryId: string;
  bibs: string[];
}

@Injectable()
export class BatchOrganizerService {
  private readonly logger = new Logger(BatchOrganizerService.name);

  constructor(private cloudinaryService: CloudinaryService) {}

  async organizePhotosByBibs(photos: PhotoWithBibs[]): Promise<void> {
    this.logger.log(`Organizando ${photos.length} fotos por dorsales`);

    for (const photo of photos) {
      try {
        await this.organizePhotoByBibs(photo);
      } catch (error) {
        this.logger.error(`Error organizando foto ${photo.photoId}: ${getErrorMessage(error)}`);
        // Continue with next photo
      }
    }

    this.logger.log('Organización por dorsales completada');
  }

  private async organizePhotoByBibs(photo: PhotoWithBibs): Promise<void> {
    const { photoId, eventId, cloudinaryId, bibs } = photo;

    // Para cada dorsal detectado, crear copias organizadas
    for (const bib of bibs) {
      await Promise.all([
        this.copyToOrganizedFolder(cloudinaryId, eventId, photoId, bib, 'original'),
        this.copyToOrganizedFolder(cloudinaryId, eventId, photoId, bib, 'thumb'),
        this.copyToOrganizedFolder(cloudinaryId, eventId, photoId, bib, 'watermark'),
      ]);
    }

    this.logger.debug(`Foto ${photoId} organizada en ${bibs.length} carpetas de dorsales`);
  }

  private async copyToOrganizedFolder(
    sourceCloudinaryId: string,
    eventId: string,
    photoId: string,
    bib: string,
    type: 'original' | 'thumb' | 'watermark',
  ): Promise<void> {
    try {
      const folder = this.getFolderPath(eventId, bib, type);
      
      // Use Cloudinary's explicit method to create organized copies
      await this.cloudinaryService.copyToFolder(
        sourceCloudinaryId,
        folder,
        `${photoId}-${type}`,
        type === 'thumb' ? 'thumb' : type === 'watermark' ? 'watermark' : 'original'
      );
    } catch (error) {
      this.logger.error(`Error copiando a carpeta organizada: ${getErrorMessage(error)}`);
      throw error;
    }
  }

  private getFolderPath(eventId: string, bib: string, type: string): string {
    return `events/${eventId}/${type}/dorsal-${bib}`;
  }
}