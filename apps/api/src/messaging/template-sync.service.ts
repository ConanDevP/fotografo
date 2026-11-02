import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { ChannelsService } from './channels.service';

/** Meta aprueba o rechaza las plantillas por su cuenta: aquí se entera LucilaMon y avisa al cliente. */
@Injectable()
export class TemplateSyncService {
  private readonly logger = new Logger(TemplateSyncService.name);

  constructor(private readonly channels: ChannelsService) {}

  @Cron('*/15 * * * *')
  async run(): Promise<void> {
    const changed = await this.channels.syncPendingTemplates().catch(error => {
      this.logger.warn(`Revisión de plantillas fallida: ${error instanceof Error ? error.message : error}`);
      return 0;
    });
    if (changed) this.logger.log(`Plantillas con novedades en ${changed} espacio(s)`);
  }
}
