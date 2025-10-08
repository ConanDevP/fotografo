import { Module } from '@nestjs/common';
import { EventsService } from './events.service';
import { EventsController } from './events.controller';
import { FreeDownloadsService } from './free-downloads.service';
import { FreeDownloadsController } from './free-downloads.controller';
import { PrismaService } from '../common/services/prisma.service';
import { CloudinaryService } from '../common/services/cloudinary.service';
import { StorageService } from '../common/services/storage.service';
import { R2Service } from '../common/services/r2.service';
import { SharpTransformService } from '../common/services/sharp-transform.service';

@Module({
  controllers: [EventsController, FreeDownloadsController],
  providers: [
    EventsService,
    FreeDownloadsService,
    PrismaService,
    CloudinaryService,
    StorageService,
    R2Service,
    SharpTransformService,
  ],
  exports: [EventsService, FreeDownloadsService],
})
export class EventsModule {}