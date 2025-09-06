import { Module } from '@nestjs/common';
import { EventsService } from './events.service';
import { EventsController } from './events.controller';
import { PrismaService } from '../common/services/prisma.service';
import { CloudinaryService } from '../common/services/cloudinary.service';

@Module({
  controllers: [EventsController],
  providers: [EventsService, PrismaService, CloudinaryService],
  exports: [EventsService],
})
export class EventsModule {}