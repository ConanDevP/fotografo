import { Module } from '@nestjs/common';
import { PhotosService } from './photos.service';
import { PhotosController } from './photos.controller';
import { PrismaService } from '../common/services/prisma.service';
import { CloudinaryService } from '../common/services/cloudinary.service';
import { QueueService } from '../common/services/queue.service';

@Module({
  controllers: [PhotosController],
  providers: [PhotosService, PrismaService, CloudinaryService, QueueService],
  exports: [PhotosService],
})
export class PhotosModule {}