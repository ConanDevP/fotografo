import { Module } from '@nestjs/common';
import { SearchService } from './search.service';
import { FaceSearchService } from './face-search.service';
import { SearchController } from './search.controller';
import { PrismaService } from '../common/services/prisma.service';
import { QueueService } from '../common/services/queue.service';
import { CloudinaryService } from '../common/services/cloudinary.service';
import { FaceApiService } from '../../../worker/src/services/face-api.service';

@Module({
  controllers: [SearchController],
  providers: [
    SearchService, 
    FaceSearchService,
    PrismaService, 
    QueueService, 
    CloudinaryService,
    FaceApiService,
  ],
  exports: [SearchService, FaceSearchService],
})
export class SearchModule {}