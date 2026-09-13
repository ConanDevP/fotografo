import { Module } from '@nestjs/common';
import { SearchService } from './search.service';
import { FaceSearchService } from './face-search.service';
import { IdentityResolverService } from './identity-resolver.service';
import { ShareCardService } from './share-card.service';
import { SearchController } from './search.controller';
import { PrismaService } from '../common/services/prisma.service';
import { QueueService } from '../common/services/queue.service';
import { CloudinaryService } from '../common/services/cloudinary.service';
import { StorageService } from '../common/services/storage.service';
import { R2Service } from '../common/services/r2.service';
import { SharpTransformService } from '../common/services/sharp-transform.service';
import { PythonFaceApiService } from '../../../worker/src/services/python-face-api.service';
import { BillingModule } from '../billing/billing.module';

@Module({
  imports: [BillingModule],
  controllers: [SearchController],
  providers: [
    SearchService,
    FaceSearchService,
    IdentityResolverService,
    ShareCardService,
    PrismaService,
    QueueService,
    CloudinaryService,
    StorageService,
    R2Service,
    SharpTransformService,
    PythonFaceApiService,
  ],
  exports: [SearchService, FaceSearchService, IdentityResolverService],
})
export class SearchModule {}