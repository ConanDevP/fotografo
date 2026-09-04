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
import { AdminIntegrationsService } from './admin-integrations.service';
import { AdminIntegrationsController } from './admin-integrations.controller';
import { AdminPlanAccessController } from './admin-plan-access.controller';
import { AdminPlanAccessService } from './admin-plan-access.service';
import { AdminEnterpriseController } from './admin-enterprise.controller';
import { AdminEnterpriseService } from './admin-enterprise.service';
import { PrismaService } from '../common/services/prisma.service';
import { CloudinaryService } from '../common/services/cloudinary.service';
import { QueueService } from '../common/services/queue.service';
import { EventsModule } from '../events/events.module';

@Module({
  // El borrado permanente de eventos reutiliza el del panel del fotógrafo, que
  // es el que libera cuota y limpia el almacenamiento. Tener dos borrados
  // distintos era justamente lo que dejaba uno de ellos roto y con fugas.
  imports: [EventsModule],
  controllers: [
    AdminController,
    AdminUsersController,
    AdminOrdersController,
    AdminEventsController,
    AdminPhotosController,
    AdminBatchJobsController,
    AdminSubscriptionsController,
    AdminSystemController,
    AdminIntegrationsController,
    AdminPlanAccessController,
    AdminEnterpriseController,
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
    AdminIntegrationsService,
    AdminPlanAccessService,
    AdminEnterpriseService,
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
    AdminIntegrationsService,
  ],
})
export class AdminModule {}
