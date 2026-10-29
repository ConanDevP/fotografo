import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { ERROR_CODES } from '@shared/constants';

/** Prisma rechaza con P2023 los valores que no tienen forma de UUID (p. ej. `/events/abc`). */
export function isMalformedIdentifier(exception: unknown): boolean {
  const e = exception as { code?: string; message?: string; name?: string } | null;
  if (!e || typeof e !== 'object') return false;
  return e.code === 'P2023' || (e.name === 'PrismaClientKnownRequestError' && /Error creating UUID|invalid character in UUID/i.test(e.message ?? ''));
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status: number;
    let errorCode: string;
    let message: string;
    let details: any;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const exceptionResponse = exception.getResponse();
      
      if (typeof exceptionResponse === 'object' && exceptionResponse !== null) {
        const errorObj = exceptionResponse as any;
        errorCode = errorObj.code || this.getErrorCodeFromStatus(status);
        message = errorObj.message || exception.message;
        // Los datos extra de la excepción (p. ej. `limit`, `used`, `resetsAt` en los topes del
        // contrato) viajan en `details`: antes se descartaban y el cliente solo veía el texto.
        const { code: _code, message: _message, details: explicit, statusCode: _status, error: _error, ...extra } = errorObj;
        details = explicit ?? (Object.keys(extra).length ? extra : undefined);
      } else {
        errorCode = this.getErrorCodeFromStatus(status);
        message = exceptionResponse as string;
      }
    } else if (isMalformedIdentifier(exception)) {
      // Un id que no es UUID no es un fallo del servidor: es una petición mal formada.
      status = HttpStatus.BAD_REQUEST;
      errorCode = ERROR_CODES.VALIDATION_ERROR;
      message = 'Identificador inválido: debe ser un UUID';
    } else {
      status = HttpStatus.INTERNAL_SERVER_ERROR;
      errorCode = ERROR_CODES.INTERNAL_ERROR;
      message = 'Error interno del servidor';
      
      // Log unexpected errors
      this.logger.error(
        `Unexpected error: ${exception}`,
        exception instanceof Error ? exception.stack : undefined,
        `${request.method} ${request.url}`,
      );
    }

    const errorResponse = {
      error: {
        code: errorCode,
        message,
        ...(details && { details }),
      },
      timestamp: new Date().toISOString(),
      path: request.url,
    };

    response.status(status).json(errorResponse);
  }

  private getErrorCodeFromStatus(status: number): string {
    switch (status) {
      case HttpStatus.UNAUTHORIZED:
        return ERROR_CODES.UNAUTHORIZED;
      case HttpStatus.FORBIDDEN:
        return ERROR_CODES.FORBIDDEN;
      case HttpStatus.NOT_FOUND:
        return 'NOT_FOUND';
      case HttpStatus.BAD_REQUEST:
        return ERROR_CODES.VALIDATION_ERROR;
      case HttpStatus.TOO_MANY_REQUESTS:
        return ERROR_CODES.RATE_LIMITED;
      case HttpStatus.CONFLICT:
        return 'CONFLICT';
      case HttpStatus.PAYLOAD_TOO_LARGE:
        return 'PAYLOAD_TOO_LARGE';
      case HttpStatus.SERVICE_UNAVAILABLE:
        return 'SERVICE_UNAVAILABLE';
      default:
        return ERROR_CODES.INTERNAL_ERROR;
    }
  }
}