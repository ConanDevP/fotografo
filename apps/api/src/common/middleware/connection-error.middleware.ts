import { Injectable, NestMiddleware, Logger } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';

@Injectable()
export class ConnectionErrorMiddleware implements NestMiddleware {
  private readonly logger = new Logger(ConnectionErrorMiddleware.name);

  use(req: Request, res: Response, next: NextFunction) {
    // Manejar errores de conexión en el request
    req.on('error', (err: any) => {
      if (err.code === 'ECONNRESET') {
        this.logger.warn(`Connection reset on ${req.method} ${req.url}`);
        return;
      }
      this.logger.error('Request error:', err);
    });

    // Manejar errores de conexión en el response
    res.on('error', (err: any) => {
      if (err.code === 'ECONNRESET') {
        this.logger.warn(`Response connection reset on ${req.method} ${req.url}`);
        return;
      }
      this.logger.error('Response error:', err);
    });

    // Detectar si el cliente se desconecta
    res.on('close', () => {
      if (!res.headersSent) {
        this.logger.warn(`Client disconnected before response sent: ${req.method} ${req.url}`);
      }
    });

    next();
  }
}