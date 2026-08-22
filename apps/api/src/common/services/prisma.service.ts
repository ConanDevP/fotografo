import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    // Usar DATABASE_URL del .env directamente (ya incluye connection_limit optimizado)
    super({
      log: [
        { level: 'error', emit: 'event' }, // Solo errors, no warnings para reducir logs
      ],
    });
  }

  async onModuleInit() {
    // Log errors only
    this.$on('error' as never, (e: any) => {
      this.logger.error(e.message);
    });

    await this.$connect();
    this.logger.log('Database connected with connection pool');

    // Middleware para soft delete de eventos
    this.$use(async (params, next) => {
      // Solo aplicar a operaciones de Event
      if (params.model === 'Event') {
        // Para operaciones de lectura, excluir eventos eliminados
        if (['findFirst', 'findUnique', 'findMany', 'count'].includes(params.action)) {
          // `count()` y `findMany()` se pueden invocar sin argumentos, en cuyo
          // caso `params.args` llega undefined y no se puede indexar.
          if (!params.args) {
            params.args = {};
          }
          if (!params.args.where) {
            params.args.where = {};
          }

          // Solo agregar filtro si no se está buscando específicamente eventos eliminados
          if (params.args.where.deletedAt === undefined) {
            params.args.where.deletedAt = null;
          }
        }
      }
      return next(params);
    });
  }

  async onModuleDestroy() {
    this.logger.log('Disconnecting from database...');
    await this.$disconnect();
  }
}