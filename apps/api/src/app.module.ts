import { Module, MiddlewareConsumer } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { UserThrottlerGuard } from './common/guards/user-throttler.guard';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';

import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { EventsModule } from './events/events.module';
import { UploadsModule } from './uploads/uploads.module';
import { PhotosModule } from './photos/photos.module';
import { SearchModule } from './search/search.module';
import { PaymentsModule } from './payments/payments.module';
import { AdminModule } from './admin/admin.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { PhotographersModule } from './photographers/photographers.module';
import { PublicModule } from './public/public.module';
import { WorkspacesModule } from './workspaces/workspaces.module';
import { SponsorsModule } from './sponsors/sponsors.module';
import { MetricsModule } from './metrics/metrics.module';
import { BillingModule } from './billing/billing.module';
import { ConnectionErrorMiddleware } from './common/middleware/connection-error.middleware';
import { HealthController } from './common/health.controller';
import { validateEnvironment } from './common/config/validate-environment';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnvironment,
    }),
    ThrottlerModule.forRoot({
      ttl: 60,
      limit: 100,
    }),
    AuthModule,
    UsersModule,
    EventsModule,
    UploadsModule,
    PhotosModule,
    SearchModule,
    PaymentsModule,
    AdminModule,
    WebhooksModule,
    PhotographersModule,
    PublicModule,
    WorkspacesModule,
    SponsorsModule,
    MetricsModule,
    BillingModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: UserThrottlerGuard,
    },
  ],
  controllers: [HealthController],
})
export class AppModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(ConnectionErrorMiddleware)
      .forRoutes('*');
  }
}
