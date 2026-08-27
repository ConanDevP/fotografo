import * as dotenv from 'dotenv';
dotenv.config();

import { NestFactory } from '@nestjs/core';
import { Logger, LogLevel } from '@nestjs/common';
import { WorkerModule } from './worker.module';

async function bootstrap() {
  // Nest imprime `debug` y `verbose` por defecto. Las trazas por firma y por
  // comparación sirven para depurar el reconocimiento, pero en marcha normal
  // son decenas de miles de líneas por trabajo y tapan lo único que hay que
  // leer. Se recuperan arrancando con LOG_LEVEL=debug.
  const levels: LogLevel[] = process.env.LOG_LEVEL === 'debug'
    ? ['error', 'warn', 'log', 'debug', 'verbose']
    : ['error', 'warn', 'log'];

  const app = await NestFactory.create(WorkerModule, { logger: levels });
  const logger = new Logger('WorkerBootstrap');

  // Graceful shutdown
  process.on('SIGINT', async () => {
    logger.log('Recibida señal SIGINT, cerrando worker...');
    await app.close();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    logger.log('Recibida señal SIGTERM, cerrando worker...');
    await app.close();
    process.exit(0);
  });

  logger.log('🔄 Worker iniciado y esperando trabajos');
  
  // Keep the process alive
  await app.init();
}

bootstrap().catch((error) => {
  console.error('Error iniciando worker:', error);
  process.exit(1);
});