import { Module } from '@nestjs/common';
import { UploadsService } from './uploads.service';
import { UploadsController } from './uploads.controller';
import { CloudinaryService } from '../common/services/cloudinary.service';
import { PrismaService } from '../common/services/prisma.service';
import { QueueService } from '../common/services/queue.service';

@Module({
  controllers: [UploadsController],
  providers: [UploadsService, CloudinaryService, PrismaService, QueueService],
  exports: [UploadsService],
})
export class UploadsModule {}