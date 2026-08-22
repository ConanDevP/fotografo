// Polyfill para crypto.randomUUID() requerido por @nestjs/schedule en Node.js v18
import { randomUUID } from 'crypto';
if (typeof globalThis.crypto === 'undefined') {
  globalThis.crypto = { randomUUID } as any;
}
import * as dotenv from 'dotenv';
dotenv.config();

// JSON.stringify no sabe serializar BigInt y lanza TypeError. Prisma devuelve
// BigInt en los identificadores de dorsal y en los contadores de bytes, así que
// se emiten como texto: por encima de 2^53 un number perdería precisión.
(BigInt.prototype as any).toJSON = function () {
  return this.toString();
};

import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';
import * as compression from 'compression';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { WorkspacesService } from './workspaces/workspaces.service';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: ['error', 'warn', 'log'],
    rawBody: true,
  });

  // Enable graceful shutdown
  app.enableShutdownHooks();

  const configService = app.get(ConfigService);

  // Caddy is the only public hop in the production topology. This preserves
  // per-client rate limits and privacy hashes instead of grouping every user
  // under the proxy container address.
  if (configService.get('NODE_ENV') === 'production') {
    app.set('trust proxy', Number(configService.get('TRUST_PROXY_HOPS', 1)));
  }

  // Security
  app.use(helmet());
  app.use(compression());

  // File uploads use multipart handlers. JSON should never accept hundreds of MB.
  const jsonBodyLimit = configService.get('API_JSON_BODY_LIMIT', '10mb');
  app.useBodyParser('json', { limit: jsonBodyLimit });
  app.useBodyParser('urlencoded', { limit: jsonBodyLimit, extended: true });

  // CORS
  const configuredOrigins = new Set(
    (configService.get('CORS_ORIGINS') || 'http://localhost:3000')
      .split(',')
      .map((origin: string) => origin.trim().replace(/\/$/, ''))
      .filter(Boolean),
  );
  const workspacesService = app.get(WorkspacesService);
  const customOriginCache = new Map<string, { allowed: boolean; expiresAt: number }>();
  app.enableCors({
    origin: (origin, callback) => {
      if (!origin || configuredOrigins.has(origin.replace(/\/$/, ''))) {
        callback(null, true);
        return;
      }

      let parsed: URL;
      try {
        parsed = new URL(origin);
      } catch {
        callback(null, false);
        return;
      }
      const production = configService.get('NODE_ENV') === 'production';
      if (
        (production && parsed.protocol !== 'https:')
        || parsed.username
        || parsed.password
        || parsed.port
        || parsed.pathname !== '/'
        || parsed.search
        || parsed.hash
      ) {
        callback(null, false);
        return;
      }

      const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
      const cached = customOriginCache.get(host);
      if (cached && cached.expiresAt > Date.now()) {
        callback(null, cached.allowed);
        return;
      }

      workspacesService.authorizeTlsDomain(host)
        .then(() => {
          customOriginCache.set(host, { allowed: true, expiresAt: Date.now() + 5 * 60_000 });
          callback(null, true);
        })
        .catch(() => {
          customOriginCache.set(host, { allowed: false, expiresAt: Date.now() + 15_000 });
          callback(null, false);
        });
    },
    credentials: true,
    maxAge: 600,
    exposedHeaders: ['Content-Disposition'],
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

  // NUEVO: Límite máximo de conexiones HTTP
  server.maxConnections = parseInt(configService.get('MAX_HTTP_CONNECTIONS', '200'));

  // NUEVO: Timeout para requests largos
  server.timeout = parseInt(configService.get('HTTP_TIMEOUT', '120000')); // 2 minutos

  // Manejar errores de conexión
  server.on('clientError', (err: NodeJS.ErrnoException, socket) => {
    if (err.code === 'ECONNRESET' || !socket.writable) {
      // MEJORADO: Cerrar socket explícitamente
      if (socket && !socket.destroyed) {
        socket.destroy();
      }
      return;
    }
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  // NUEVO: Manejar conexiones que se cierran abruptamente
  server.on('connection', (socket) => {
    socket.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ECONNRESET' || err.code === 'EPIPE') {
        return; // Silenciar errores comunes de conexión
      }
      console.error('Socket error:', err);
    });
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
    process.exit(1);
  });

  console.log(`🚀 API corriendo en puerto ${port}`);
}

bootstrap();
