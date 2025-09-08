import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit {
  async onModuleInit() {
    await this.$connect();

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
    await this.$disconnect();
  }
}