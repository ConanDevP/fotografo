import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, DeleteObjectsCommand, HeadObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import * as https from 'https';
import { getErrorMessage, getErrorStack } from '@shared/utils';

@Injectable()
export class R2Service {
  private readonly logger = new Logger(R2Service.name);
  private readonly s3Client: S3Client;
  private readonly bucketName: string;
  private readonly publicBucketName: string;
  private readonly publicUrl: string;

  constructor(private configService: ConfigService) {
    const accountId = this.configService.get('R2_ACCOUNT_ID');
    const accessKeyId = this.configService.get('R2_ACCESS_KEY_ID');
    const secretAccessKey = this.configService.get('R2_SECRET_ACCESS_KEY');

    this.bucketName = this.configService.get('R2_BUCKET_NAME', 'fotografos-images');
    this.publicBucketName = this.configService.get('R2_PUBLIC_BUCKET_NAME', this.bucketName);
    this.publicUrl = this.configService.get('R2_PUBLIC_URL', '');
    const isProductionR2 = this.configService.get('NODE_ENV') === 'production'
      && this.configService.get('STORAGE_PROVIDER', 'cloudinary') === 'r2';
    if (isProductionR2) {
      const missing = [
        ['R2_ACCOUNT_ID', accountId],
        ['R2_ACCESS_KEY_ID', accessKeyId],
        ['R2_SECRET_ACCESS_KEY', secretAccessKey],
        ['R2_BUCKET_NAME', this.bucketName],
        ['R2_PUBLIC_BUCKET_NAME', this.publicBucketName],
        ['R2_PUBLIC_URL', this.publicUrl],
      ].filter(([, value]) => !value).map(([name]) => name);
      if (missing.length) throw new Error(`Falta configuración R2 de producción: ${missing.join(', ')}`);
    }
    if (
      isProductionR2
      && this.publicBucketName === this.bucketName
    ) {
      throw new Error('R2_PUBLIC_BUCKET_NAME debe ser distinto de R2_BUCKET_NAME en producción');
    }

    // Create HTTPS agent with proper TLS configuration
    const httpsAgent = new https.Agent({
      keepAlive: true,
      maxSockets: 50,
      timeout: 120000, // 2 minutes
      // Force TLS 1.2+ for Cloudflare compatibility
      minVersion: 'TLSv1.2',
    });

    this.s3Client = new S3Client({
      region: 'auto',
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
      maxAttempts: 3,
      requestHandler: new NodeHttpHandler({
        httpsAgent,
        connectionTimeout: 30000, // 30 seconds to establish connection
        socketTimeout: 120000, // 2 minutes for data transfer
      }),
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
      const extension = file.mimetype === 'image/png' ? 'png' : 'jpg';
      const key = `events/${eventId}/original/${photoId}.${extension}`;

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

      // Originals must never be persisted as a public delivery URL. The object
      // key is the canonical reference and downloads are always signed below.
      const originalUrl = `r2://${this.bucketName}/${key}`;

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

  async generateUploadUrl(
    key: string,
    contentType: string,
    expiresIn = 3600
  ): Promise<{ uploadUrl: string; key: string }> {
    try {
      const command = new PutObjectCommand({
        Bucket: this.bucketName,
        Key: key,
        ContentType: contentType,
        Metadata: {
          uploadedAt: new Date().toISOString(),
        },
      });

      const uploadUrl = await getSignedUrl(this.s3Client, command, {
        expiresIn,
      });

      this.logger.log(`Generated upload URL for key: ${key}, expires in ${expiresIn}s`);

      return { uploadUrl, key };
    } catch (error) {
      this.logger.error(`Error generando URL de subida: ${getErrorMessage(error)}`);
      throw error;
    }
  }

  /**
   * Datos reales del objeto ya subido. Con subida directa, el tamaño que declara
   * el cliente no es fiable —de él depende la facturación—, así que se comprueba
   * contra lo que R2 tiene de verdad.
   */
  async headPhoto(key: string): Promise<{ size: number; contentType?: string } | null> {
    try {
      const result = await this.s3Client.send(
        new HeadObjectCommand({ Bucket: this.bucketName, Key: key }),
      );
      return { size: Number(result.ContentLength ?? 0), contentType: result.ContentType };
    } catch (error) {
      // Un objeto ausente no es un error del sistema: es que el cliente aún no
      // ha subido ese archivo, o falló al hacerlo.
      return null;
    }
  }

  /**
   * Lee los primeros bytes de un objeto para validar su firma. Sin esto, con
   * subida directa cualquier archivo podría acabar almacenado como si fuera una
   * fotografía, porque el servidor ya no ve el contenido al pasar.
   */
  async readHead(key: string, bytes = 16): Promise<Buffer | null> {
    try {
      const result = await this.s3Client.send(
        new GetObjectCommand({
          Bucket: this.bucketName,
          Key: key,
          Range: `bytes=0-${bytes - 1}`,
        }),
      );
      const chunks: Buffer[] = [];
      for await (const chunk of result.Body as AsyncIterable<Uint8Array>) {
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    } catch (error) {
      this.logger.warn(`No se pudieron leer los primeros bytes de ${key}: ${getErrorMessage(error)}`);
      return null;
    }
  }

  async generateSecureDownloadUrl(key: string, expiresIn = 300): Promise<string> {
    try {
      const isExplicitlyPrivate = key.startsWith('private:');
      const objectKey = isExplicitlyPrivate ? key.slice('private:'.length) : key;
      // Sponsored assets created by older versions lived in the public bucket.
      // New private assets carry a marker; originals have always used the private key path.
      const bucket = !isExplicitlyPrivate && objectKey.includes('/downloads/')
        ? this.publicBucketName
        : this.bucketName;
      // Extract filename from key for better download experience
      const filename = objectKey.split('/').pop() || 'download.jpg';

      const command = new GetObjectCommand({
        Bucket: bucket,
        Key: objectKey,
        ResponseContentDisposition: `attachment; filename="${filename}"`,
      });

      const signedUrl = await getSignedUrl(this.s3Client, command, {
        expiresIn,
      });

      // IMPORTANT: Do NOT use custom domain for signed URLs with response headers
      // Custom domains (R2 custom domains) do not respect ResponseContentDisposition
      // We must use the direct R2 endpoint URL for downloads to work properly
      this.logger.log(`Generated download URL for key: ${objectKey}, expires in ${expiresIn}s`);

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

  /**
   * Borra todo lo que cuelga de un prefijo, en los dos cubos.
   *
   * Cada objeto de un evento vive bajo `events/{id}/` — original, miniatura,
   * marca de agua, portada y descargas patrocinadas — así que barrer el
   * prefijo se lleva también lo que ninguna fila de la base referencia: los
   * restos de subidas que fallaron a medias. Recorrer foto por foto los habría
   * dejado ahí, ocupando y pagándose para siempre.
   *
   * No lanza. Quien llama ya ha borrado las filas, y dejar la base a medias
   * sería peor que arrastrar unos objetos huérfanos que podemos limpiar luego.
   */
  async deletePrefix(prefix: string): Promise<{ deleted: number; failed: number }> {
    let deleted = 0;
    let failed = 0;

    for (const bucket of [this.bucketName, this.publicBucketName]) {
      if (!bucket) continue;
      let continuationToken: string | undefined;

      do {
        try {
          const listed = await this.s3Client.send(new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix,
            ContinuationToken: continuationToken,
          }));

          const keys = (listed.Contents || [])
            .map(object => object.Key)
            .filter((key): key is string => Boolean(key));

          if (keys.length) {
            // La API acepta 1000 claves por llamada: un evento de 2.000
            // fotografías se resuelve en un puñado de peticiones en lugar de
            // una por objeto.
            const response = await this.s3Client.send(new DeleteObjectsCommand({
              Bucket: bucket,
              Delete: { Objects: keys.map(Key => ({ Key })), Quiet: true },
            }));
            const errors = (response.Errors || []).length;
            failed += errors;
            deleted += keys.length - errors;
          }

          continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
        } catch (error) {
          this.logger.error(`Error borrando el prefijo ${prefix} en ${bucket}: ${getErrorMessage(error)}`);
          failed += 1;
          continuationToken = undefined;
        }
      } while (continuationToken);
    }

    this.logger.log(`Prefijo ${prefix}: ${deleted} objeto(s) borrado(s), ${failed} fallo(s)`);
    return { deleted, failed };
  }

  buildUrl(key: string): string {
    return this.publicUrl
      ? `${this.publicUrl}/${key}`
      : `https://${this.publicBucketName}.r2.dev/${key}`;
  }

  async uploadImage(
    buffer: Buffer,
    key: string,
    contentType: string = 'image/jpeg'
  ): Promise<string> {
    try {
      const command = new PutObjectCommand({
        Bucket: this.publicBucketName,
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
    try {
      const isPrivate = key.startsWith('private:');
      const objectKey = isPrivate ? key.slice('private:'.length) : key;
      await this.s3Client.send(new DeleteObjectCommand({
        Bucket: isPrivate ? this.bucketName : this.publicBucketName,
        Key: objectKey,
      }));
      this.logger.log(`Imagen eliminada de R2: ${objectKey}`);
    } catch (error) {
      this.logger.error(`Error eliminando imagen pública: ${getErrorMessage(error)}`, getErrorStack(error));
      throw error;
    }
  }

  async uploadPrivateImage(
    buffer: Buffer,
    key: string,
    contentType = 'image/jpeg',
  ): Promise<{ key: string; url: string }> {
    await this.s3Client.send(new PutObjectCommand({
      Bucket: this.bucketName,
      Key: key,
      Body: buffer,
      ContentType: contentType,
    }));
    this.logger.log(`Imagen privada subida a R2: ${key}`);
    return { key: `private:${key}`, url: `r2://${this.bucketName}/${key}` };
  }

  async uploadAvatar(
    file: Express.Multer.File,
    userId: string,
  ): Promise<{
    key: string;
    url: string;
  }> {
    try {
      const extension = file.mimetype === 'image/png' ? 'png' : file.mimetype === 'image/webp' ? 'webp' : 'jpg';
      const key = `avatars/${userId}/avatar.${extension}`;

      const command = new PutObjectCommand({
        Bucket: this.publicBucketName,
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
        : `https://${this.publicBucketName}.r2.dev/${key}`;

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
