import { Module } from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { PaymentsController } from './payments.controller';
import { PrismaService } from '../common/services/prisma.service';
import { CloudinaryService } from '../common/services/cloudinary.service';
import { QueueService } from '../common/services/queue.service';

@Module({
  controllers: [PaymentsController],
  providers: [PaymentsService, PrismaService, CloudinaryService, QueueService],
  exports: [PaymentsService],
})
export class PaymentsModule {}