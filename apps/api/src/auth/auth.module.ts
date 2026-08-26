import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';

import { AuthService } from './auth.service';
import { PasswordResetService } from './password-reset.service';
import { MailerService } from '../common/services/mailer.service';
import { AuthController } from './auth.controller';
import { RedisService } from './redis.service';
import { UsersModule } from '../users/users.module';
import { R2Service } from '../common/services/r2.service';
import { CloudinaryService } from '../common/services/cloudinary.service';
import { SharpTransformService } from '../common/services/sharp-transform.service';
import { StorageService } from '../common/services/storage.service';
import { PrismaService } from '../common/services/prisma.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { LocalStrategy } from './strategies/local.strategy';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { normalizePem } from '../common/config/validate-environment';

@Module({
  imports: [
    UsersModule,
    WorkspacesModule,
    PassportModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => ({
        privateKey: normalizePem(configService.get('JWT_PRIVATE_KEY')),
        publicKey: normalizePem(configService.get('JWT_PUBLIC_KEY')),
        signOptions: {
          expiresIn: configService.get('JWT_ACCESS_EXPIRY', '15m'),
          algorithm: 'RS256',
        },
      }),
      inject: [ConfigService],
    }),
  ],
  providers: [AuthService, RedisService, JwtStrategy, LocalStrategy, R2Service, CloudinaryService, SharpTransformService, StorageService, PrismaService, PasswordResetService, MailerService],
  controllers: [AuthController],
  exports: [AuthService],
})
export class AuthModule {}
