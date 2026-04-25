import { Module } from '@nestjs/common';
import { PublicController } from './public.controller';
import { PublicService } from './public.service';
import { PrismaService } from '../common/services/prisma.service';
import { CloudinaryService } from '../common/services/cloudinary.service';

@Module({
  controllers: [PublicController],
  providers: [PublicService, PrismaService, CloudinaryService],
  exports: [PublicService],
})
export class PublicModule {}
