import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v2 as cloudinary, UploadApiResponse, UploadApiErrorResponse } from 'cloudinary';
import { CLOUDINARY_FOLDERS, CLOUDINARY_TRANSFORMS } from '@shared/constants';
import { getErrorMessage, getErrorStack } from '@shared/utils';

@Injectable()
export class CloudinaryService {
  private readonly logger = new Logger(CloudinaryService.name);

  constructor(private configService: ConfigService) {
    cloudinary.config({
      cloud_name: this.configService.get('CLOUDINARY_CLOUD_NAME'),
      api_key: this.configService.get('CLOUDINARY_API_KEY'),
      api_secret: this.configService.get('CLOUDINARY_API_SECRET'),
      secure: this.configService.get('CLOUDINARY_SECURE', 'true') === 'true',
    });
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
    try {
      const folder = CLOUDINARY_FOLDERS.ORIGINAL(eventId);
      
      const result = await cloudinary.uploader.upload(`data:${file.mimetype};base64,${file.buffer.toString('base64')}`, {
        resource_type: 'auto',
        folder,
        public_id: photoId,
        format: 'jpg',
        quality: 'auto:best',
        flags: 'progressive',
        tags: ['photo', 'original', eventId],
      });

      this.logger.log(`Foto subida a Cloudinary: ${result.public_id}`);

      return {
        cloudinaryId: result.public_id,
        originalUrl: result.secure_url,
        width: result.width,
        height: result.height,
      };
    } catch (error) {
      this.logger.error(`Error subiendo foto a Cloudinary:`, {
        error: getErrorMessage(error),
        stack: getErrorStack(error),
        cloudName: this.configService.get('CLOUDINARY_CLOUD_NAME'),
        hasApiKey: !!this.configService.get('CLOUDINARY_API_KEY'),
        hasApiSecret: !!this.configService.get('CLOUDINARY_API_SECRET'),
        fileSize: file?.size,
        mimetype: file?.mimetype,
        eventId,
        photoId
      });
      throw error;
    }
  }

  async generateThumbnail(cloudinaryId: string, eventId: string, photoId: string): Promise<string> {
    try {
      const folder = CLOUDINARY_FOLDERS.THUMB(eventId);
      const targetPublicId = photoId; // Solo el photoId, no la carpeta completa
      
      this.logger.debug(`Generando thumbnail para ${cloudinaryId} en carpeta ${folder} con ID ${targetPublicId}`);

      // Create thumbnail by uploading transformed version
      const result = await cloudinary.uploader.upload(
        cloudinary.url(cloudinaryId, {
          transformation: [
            { width: 800, crop: 'limit' },
            { quality: 70 },
            { format: 'jpg' }
          ]
        }),
        {
          folder: folder, // Usar folder separado
          public_id: targetPublicId, // Solo el ID sin carpeta
          resource_type: 'image',
          type: 'upload',
          overwrite: true,
          tags: ['thumbnail', eventId, photoId],
        }
      );

      this.logger.log(`Thumbnail generado: ${result.secure_url}`);
      return result.secure_url;
    } catch (error) {
      this.logger.error(`Error generando thumbnail: ${getErrorMessage(error)}`, {
        error: getErrorStack(error),
        cloudinaryId,
        eventId,
        photoId,
      });
      throw error;
    }
  }

  async generateWatermark(cloudinaryId: string, eventId: string, photoId: string): Promise<string> {
    try {
      const folder = CLOUDINARY_FOLDERS.WATERMARK(eventId);
      const targetPublicId = photoId; // Solo el photoId, no la carpeta completa
      
      this.logger.debug(`Generando watermark para ${cloudinaryId} en carpeta ${folder} con ID ${targetPublicId}`);

      // Create watermark by uploading transformed version
      const result = await cloudinary.uploader.upload(
        cloudinary.url(cloudinaryId, {
          transformation: [
            { width: 2000, crop: 'limit' },
            { quality: 80 },
            { format: 'jpg' },
            { overlay: 'text:Arial_60_bold:© Fotografo' },
            { opacity: 30 }
          ]
        }),
        {
          folder: folder, // Usar folder separado
          public_id: targetPublicId, // Solo el ID sin carpeta
          resource_type: 'image',
          type: 'upload',
          overwrite: true,
          tags: ['watermark', eventId, photoId],
        }
      );

      this.logger.log(`Watermark generado: ${result.secure_url}`);
      return result.secure_url;
    } catch (error) {
      this.logger.error(`Error generando watermark: ${getErrorMessage(error)}`, {
        error: getErrorStack(error),
        cloudinaryId,
        eventId,
        photoId,
      });
      throw error;
    }
  }

  async getOptimizedUrlForOCR(cloudinaryId: string): Promise<string> {
    return cloudinary.url(cloudinaryId, {
      transformation: [
        { width: 3000, crop: 'limit' },
        { quality: 90 },
        { format: 'jpg' },
        { effect: 'auto_contrast:10' }
      ],
      secure: true,
      sign_url: false,
    });
  }

  async deletePhoto(cloudinaryId: string): Promise<void> {
    try {
      await cloudinary.uploader.destroy(cloudinaryId);
      this.logger.log(`Foto eliminada de Cloudinary: ${cloudinaryId}`);
    } catch (error) {
      this.logger.error(`Error eliminando foto: ${getErrorMessage(error)}`, getErrorStack(error));
      throw error;
    }
  }

  async generateSecureDownloadUrl(cloudinaryId: string, expiresIn = 300): Promise<string> {
    const timestamp = Math.round(Date.now() / 1000) + expiresIn;
    
    return cloudinary.url(cloudinaryId, {
      sign_url: true,
      expires_at: timestamp,
      resource_type: 'image',
      type: 'upload',
      format: 'jpg',
      secure: true,
    });
  }

  buildUrl(cloudinaryId: string, transformation?: string): string {
    return cloudinary.url(cloudinaryId, {
      transformation,
      secure: true,
    });
  }

  async copyToFolder(
    sourceId: string,
    targetFolder: string,
    targetPublicId: string,
    transformationType: 'original' | 'thumb' | 'watermark',
  ): Promise<string> {
    try {
      let transformation: string | undefined;
      
      switch (transformationType) {
        case 'thumb':
          transformation = CLOUDINARY_TRANSFORMS.THUMB;
          break;
        case 'watermark':
          transformation = CLOUDINARY_TRANSFORMS.WATERMARK;
          break;
        default:
          transformation = undefined;
      }

      const result = await cloudinary.uploader.explicit(sourceId, {
        type: 'upload',
        eager: [{
          folder: targetFolder,
          public_id: targetPublicId,
          transformation,
        }],
      });

      const targetUrl = result.eager?.[0]?.secure_url;
      
      if (!targetUrl) {
        throw new Error('No se pudo crear copia organizada');
      }

      return targetUrl;
    } catch (error) {
      this.logger.error(`Error copiando a carpeta: ${getErrorMessage(error)}`, getErrorStack(error));
      throw error;
    }
  }

  async getBibFolderContents(eventId: string, bib: string): Promise<{
    originals: string[];
    thumbs: string[];
    watermarks: string[];
  }> {
    try {
      const [originals, thumbs, watermarks] = await Promise.all([
        this.listFolderContents(CLOUDINARY_FOLDERS.ORIGINAL(eventId, bib)),
        this.listFolderContents(CLOUDINARY_FOLDERS.THUMB(eventId, bib)),
        this.listFolderContents(CLOUDINARY_FOLDERS.WATERMARK(eventId, bib)),
      ]);

      return { originals, thumbs, watermarks };
    } catch (error) {
      this.logger.error(`Error obteniendo contenido de carpeta: ${getErrorMessage(error)}`);
      throw error;
    }
  }

  async uploadImage(
    buffer: Buffer,
    publicId: string,
    transformation?: { width?: number; height?: number; crop?: string }
  ): Promise<UploadApiResponse> {
    try {
      const uploadOptions: any = {
        resource_type: 'image',
        public_id: publicId,
        format: 'jpg',
        quality: 'auto:good',
        flags: 'progressive',
      };

      if (transformation) {
        uploadOptions.transformation = [transformation];
      }

      const result = await cloudinary.uploader.upload(
        `data:image/jpeg;base64,${buffer.toString('base64')}`,
        uploadOptions
      );

      this.logger.log(`Imagen subida a Cloudinary: ${result.public_id}`);
      return result;
    } catch (error) {
      this.logger.error(`Error subiendo imagen: ${getErrorMessage(error)}`, getErrorStack(error));
      throw error;
    }
  }

  async deleteImage(publicId: string): Promise<void> {
    try {
      await cloudinary.uploader.destroy(publicId);
      this.logger.log(`Imagen eliminada de Cloudinary: ${publicId}`);
    } catch (error) {
      this.logger.error(`Error eliminando imagen: ${getErrorMessage(error)}`, getErrorStack(error));
      throw error;
    }
  }

  private async listFolderContents(folder: string): Promise<string[]> {
    try {
      const result = await cloudinary.api.resources({
        type: 'upload',
        prefix: folder,
        max_results: 500,
      });

      return result.resources.map((resource: any) => resource.secure_url);
    } catch (error) {
      // Return empty array if folder doesn't exist yet
      return [];
    }
  }
}