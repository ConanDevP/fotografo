import * as dotenv from 'dotenv';
dotenv.config();

import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { WorkerModule } from './worker.module';

async function bootstrap() {
  const app = await NestFactory.create(WorkerModule);
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