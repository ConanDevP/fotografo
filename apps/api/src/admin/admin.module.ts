import { Module } from '@nestjs/common';
import { AdminService } from './admin.service';
import { AdminController } from './admin.controller';
import { PrismaService } from '../common/services/prisma.service';
import { CloudinaryService } from '../common/services/cloudinary.service';
import { QueueService } from '../common/services/queue.service';

@Module({
  controllers: [AdminController],
  providers: [AdminService, PrismaService, CloudinaryService, QueueService],
  exports: [AdminService],
})
export class AdminModule {}