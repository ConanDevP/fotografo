import { Module } from '@nestjs/common';
import { PhotosService } from './photos.service';
import { PhotosController } from './photos.controller';
import { PrismaService } from '../common/services/prisma.service';
import { CloudinaryService } from '../common/services/cloudinary.service';
import { R2Service } from '../common/services/r2.service';
import { SharpTransformService } from '../common/services/sharp-transform.service';
import { StorageService } from '../common/services/storage.service';
import { QueueService } from '../common/services/queue.service';

@Module({
  controllers: [PhotosController],
  providers: [PhotosService, PrismaService, CloudinaryService, R2Service, SharpTransformService, StorageService, QueueService],
  exports: [PhotosService],
})
export class PhotosModule {}