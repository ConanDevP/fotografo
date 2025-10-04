import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    const baseUrl = process.env.DATABASE_URL || '';
    const separator = baseUrl.includes('?') ? '&' : '?';
    const pooledUrl = `${baseUrl}${separator}connection_limit=10&pool_timeout=20`;

    super({
      log: [
        { level: 'warn', emit: 'event' },
        { level: 'error', emit: 'event' },
      ],
      datasources: {
        db: {
          url: pooledUrl,
        },
      },
    });
  }

  async onModuleInit() {
    // Log warnings and errors
    this.$on('warn' as never, (e: any) => {
      this.logger.warn(e.message);
    });

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