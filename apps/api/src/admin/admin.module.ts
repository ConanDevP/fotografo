import { Module } from '@nestjs/common';
import { AdminService } from './admin.service';
import { AdminController } from './admin.controller';
import { AdminUsersService } from './admin-users.service';
import { AdminUsersController } from './admin-users.controller';
import { AdminOrdersService } from './admin-orders.service';
import { AdminOrdersController } from './admin-orders.controller';
import { AdminEventsService } from './admin-events.service';
import { AdminEventsController } from './admin-events.controller';
import { AdminPhotosService } from './admin-photos.service';
import { AdminPhotosController } from './admin-photos.controller';
import { AdminBatchJobsService } from './admin-batch-jobs.service';
import { AdminBatchJobsController } from './admin-batch-jobs.controller';
import { AdminSubscriptionsService } from './admin-subscriptions.service';
import { AdminSubscriptionsController } from './admin-subscriptions.controller';
import { AdminSystemService } from './admin-system.service';
import { AdminSystemController } from './admin-system.controller';
import { PrismaService } from '../common/services/prisma.service';
import { CloudinaryService } from '../common/services/cloudinary.service';
import { QueueService } from '../common/services/queue.service';

@Module({
  controllers: [
    AdminController,
    AdminUsersController,
    AdminOrdersController,
    AdminEventsController,
    AdminPhotosController,
    AdminBatchJobsController,
    AdminSubscriptionsController,
    AdminSystemController,
  ],
  providers: [
    AdminService,
    AdminUsersService,
    AdminOrdersService,
    AdminEventsService,
    AdminPhotosService,
    AdminBatchJobsService,
    AdminSubscriptionsService,
    AdminSystemService,
    PrismaService,
    CloudinaryService,
    QueueService,
  ],
  exports: [
    AdminService,
    AdminUsersService,
    AdminOrdersService,
    AdminEventsService,
    AdminPhotosService,
    AdminBatchJobsService,
    AdminSubscriptionsService,
    AdminSystemService,
  ],
})
export class AdminModule {}