import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { getErrorMessage, getErrorStack } from '@shared/utils';

@Injectable()
export class R2Service {
  private readonly logger = new Logger(R2Service.name);
  private readonly s3Client: S3Client;
  private readonly bucketName: string;
  private readonly publicUrl: string;

  constructor(private configService: ConfigService) {
    const accountId = this.configService.get('R2_ACCOUNT_ID');
    const accessKeyId = this.configService.get('R2_ACCESS_KEY_ID');
    const secretAccessKey = this.configService.get('R2_SECRET_ACCESS_KEY');
    
    this.bucketName = this.configService.get('R2_BUCKET_NAME', 'fotografos-images');
    this.publicUrl = this.configService.get('R2_PUBLIC_URL', '');

    this.s3Client = new S3Client({
      region: 'auto',
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
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
      const key = `events/${eventId}/original/${photoId}.jpg`;
      
      const command = new PutObjectCommand({
        Bucket: this.bucketName,
        Key: key,
        Body: file.buffer,
        ContentType: file.mimetype,
        Metadata: {
          eventId,
          photoId,
          originalName: file.originalname,
        },
      });

      await this.s3Client.send(command);

      const originalUrl = this.publicUrl 
        ? `${this.publicUrl}/${key}`
        : `https://${this.bucketName}.r2.dev/${key}`;

      this.logger.log(`Foto subida a R2: ${key}`);

      // Para obtener dimensiones, necesitamos usar Sharp aquí o en el worker
      return {
        cloudinaryId: key, // Usamos el key como ID
        originalUrl,
        width: 0, // Se actualizará en el worker con Sharp
        height: 0, // Se actualizará en el worker con Sharp
      };
    } catch (error) {
      this.logger.error(`Error subiendo foto a R2:`, {
        error: getErrorMessage(error),
        stack: getErrorStack(error),
        eventId,
        photoId,
        fileSize: file?.size,
        mimetype: file?.mimetype,
      });
      throw error;
    }
  }

  async generateSecureDownloadUrl(key: string, expiresIn = 300): Promise<string> {
    try {
      const command = new GetObjectCommand({
        Bucket: this.bucketName,
        Key: key,
      });

      const signedUrl = await getSignedUrl(this.s3Client, command, {
        expiresIn,
      });

      // Si tenemos un dominio personalizado configurado, reemplazar el dominio de R2
      if (this.publicUrl) {
        const url = new URL(signedUrl);
        const customUrl = new URL(this.publicUrl);
        
        // Mantener el path y query parameters, solo cambiar el dominio
        return `${customUrl.origin}${url.pathname}${url.search}`;
      }

      return signedUrl;
    } catch (error) {
      this.logger.error(`Error generando URL firmada: ${getErrorMessage(error)}`);
      throw error;
    }
  }

  async deletePhoto(key: string): Promise<void> {
    try {
      const command = new DeleteObjectCommand({
        Bucket: this.bucketName,
        Key: key,
      });

      await this.s3Client.send(command);
      this.logger.log(`Foto eliminada de R2: ${key}`);
    } catch (error) {
      this.logger.error(`Error eliminando foto: ${getErrorMessage(error)}`, getErrorStack(error));
      throw error;
    }
  }

  buildUrl(key: string): string {
    return this.publicUrl 
      ? `${this.publicUrl}/${key}`
      : `https://${this.bucketName}.r2.dev/${key}`;
  }

  async uploadImage(
    buffer: Buffer,
    key: string,
    contentType: string = 'image/jpeg'
  ): Promise<string> {
    try {
      const command = new PutObjectCommand({
        Bucket: this.bucketName,
        Key: key,
        Body: buffer,
        ContentType: contentType,
      });

      await this.s3Client.send(command);

      const url = this.buildUrl(key);
      this.logger.log(`Imagen subida a R2: ${key}`);
      
      return url;
    } catch (error) {
      this.logger.error(`Error subiendo imagen: ${getErrorMessage(error)}`, getErrorStack(error));
      throw error;
    }
  }

  async deleteImage(key: string): Promise<void> {
    return this.deletePhoto(key);
  }

  async uploadAvatar(
    file: Express.Multer.File,
    userId: string,
  ): Promise<{
    key: string;
    url: string;
  }> {
    try {
      const extension = file.originalname.split('.').pop() || 'jpg';
      const key = `avatars/${userId}/avatar.${extension}`;
      
      const command = new PutObjectCommand({
        Bucket: this.bucketName,
        Key: key,
        Body: file.buffer,
        ContentType: file.mimetype,
        Metadata: {
          userId: userId,
          originalName: file.originalname,
          uploadedAt: new Date().toISOString(),
        },
      });

      await this.s3Client.send(command);

      const publicUrl = this.publicUrl 
        ? `${this.publicUrl}/${key}`
        : `https://${this.bucketName}.r2.cloudflarestorage.com/${key}`;

      this.logger.log(`Avatar subido exitosamente para usuario ${userId}: ${key}`);

      return {
        key,
        url: publicUrl,
      };
    } catch (error) {
      this.logger.error(`Error subiendo avatar para usuario ${userId}:`, getErrorStack(error));
      throw new Error(`Error al subir avatar: ${getErrorMessage(error)}`);
    }
  }
}