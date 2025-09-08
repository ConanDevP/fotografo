import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';

import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { UsersModule } from '../users/users.module';
import { R2Service } from '../common/services/r2.service';
import { PrismaService } from '../common/services/prisma.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { LocalStrategy } from './strategies/local.strategy';

@Module({
  imports: [
    UsersModule,
    PassportModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => ({
        privateKey: configService.get('JWT_PRIVATE_KEY'),
        publicKey: configService.get('JWT_PUBLIC_KEY'),
        signOptions: {
          expiresIn: configService.get('JWT_ACCESS_EXPIRY', '15m'),
          algorithm: 'RS256',
        },
      }),
      inject: [ConfigService],
    }),
  ],
  providers: [AuthService, JwtStrategy, LocalStrategy, R2Service, PrismaService],
  controllers: [AuthController],
  exports: [AuthService],
})
export class AuthModule {}