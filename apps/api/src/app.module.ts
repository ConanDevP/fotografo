import { Module, MiddlewareConsumer } from '@nestjs/common';
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
import { RecoveryModule } from './common/recovery.module';
import { ConnectionErrorMiddleware } from './common/middleware/connection-error.middleware';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    ThrottlerModule.forRoot({
      ttl: 60000,
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
    RecoveryModule,
  ],
})
export class AppModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(ConnectionErrorMiddleware)
      .forRoutes('*');
  }
}