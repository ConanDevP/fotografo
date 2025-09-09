import { Module } from '@nestjs/common';
import { PhotographersController } from './photographers.controller';
import { PublicPhotographersController } from './public-photographers.controller';
import { PhotographersService } from './photographers.service';
import { PublicPhotographersService } from './public-photographers.service';
import { PrismaService } from '../common/services/prisma.service';

@Module({
  controllers: [PhotographersController, PublicPhotographersController],
  providers: [PhotographersService, PublicPhotographersService, PrismaService],
  exports: [PhotographersService, PublicPhotographersService]
})
export class PhotographersModule {}