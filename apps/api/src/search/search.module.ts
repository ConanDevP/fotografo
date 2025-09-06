import { Module } from '@nestjs/common';
import { SearchService } from './search.service';
import { SearchController } from './search.controller';
import { PrismaService } from '../common/services/prisma.service';
import { QueueService } from '../common/services/queue.service';
import { CloudinaryService } from '../common/services/cloudinary.service';

@Module({
  controllers: [SearchController],
  providers: [SearchService, PrismaService, QueueService, CloudinaryService],
  exports: [SearchService],
})
export class SearchModule {}