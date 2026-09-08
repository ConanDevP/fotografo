import { forwardRef, Module } from '@nestjs/common';
import { PrismaService } from '../common/services/prisma.service';
import { WorkspacesController } from './workspaces.controller';
import { WorkspacesService } from './workspaces.service';
import { StorageService } from '../common/services/storage.service';
import { R2Service } from '../common/services/r2.service';
import { CloudinaryService } from '../common/services/cloudinary.service';
import { SharpTransformService } from '../common/services/sharp-transform.service';
import { BillingModule } from '../billing/billing.module';
import { RailwayDomainsService } from './railway-domains.service';

@Module({
  imports: [forwardRef(() => BillingModule)],
  controllers: [WorkspacesController],
  providers: [WorkspacesService, RailwayDomainsService, PrismaService, StorageService, R2Service, CloudinaryService, SharpTransformService],
  exports: [WorkspacesService],
})
export class WorkspacesModule {}

