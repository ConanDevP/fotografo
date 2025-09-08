import * as dotenv from 'dotenv';
dotenv.config();

import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';
import * as compression from 'compression';
import * as bodyParser from 'body-parser';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';

async function bootstrap() {
  // Silenciar ECONNRESET antes de crear la app
  const originalConsoleError = console.error;
  console.error = (...args) => {
    const message = args.join(' ');
    if (message.includes('ECONNRESET') || message.includes('read ECONNRESET')) {
      return;
    }
    originalConsoleError.apply(console, args);
  };

  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  const configService = app.get(ConfigService);

  // Security
  app.use(helmet());
  app.use(compression());

  // Increase payload limit for face search images (base64)
  app.use(bodyParser.json({ limit: '10mb' }));
  app.use(bodyParser.urlencoded({ limit: '10mb', extended: true }));

  // CORS
  app.enableCors({
    origin: configService.get('CORS_ORIGINS')?.split(',') || ['http://localhost:3000'],
    credentials: true,
  });



  // Global pipes
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  

  // Global filters
  app.useGlobalFilters(new AllExceptionsFilter());

  // API prefix
  app.setGlobalPrefix('v1');

  const port = configService.get('PORT', 8080);
  
  // Configurar timeouts y keep-alive
  const server = await app.listen(port);
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;
  
  // Manejar errores de conexión
  server.on('clientError', (err, socket) => {
    if (err.code === 'ECONNRESET' || !socket.writable) {
      return;
    }
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  // Silenciar errores ECONNRESET globalmente
  process.on('uncaughtException', (err: any) => {
    if (err.code === 'ECONNRESET') {
      return;
    }
    console.error('Uncaught Exception:', err);
    process.exit(1);
  });

  process.on('unhandledRejection', (reason: any, promise) => {
    if (reason && typeof reason === 'object' && 'code' in reason && reason.code === 'ECONNRESET') {
      return;
    }
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  });
  
  console.log(`🚀 API corriendo en puerto ${port}`);
}

bootstrap();