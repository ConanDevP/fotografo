import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * Cuenta las peticiones por usuario autenticado en lugar de por IP.
 *
 * Con el seguimiento por IP, dos fotógrafos cubriendo la misma carrera desde el
 * wifi del evento comparten el mismo cupo y se bloquean entre ellos. Como el
 * identificador de usuario viene de un JWT firmado, no es falsificable, así que
 * es mejor tracker que la IP siempre que haya sesión.
 */
@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  protected getTracker(req: Record<string, any>): string {
    const userId = req?.user?.id;
    if (userId) return `user:${userId}`;

    // El throttler global corre antes que el guard de Partner API, de modo que
    // todavía no existe req.partner. El prefijo público identifica la clave sin
    // copiar el secreto al tracker ni a Redis y evita que integraciones detrás
    // de la misma NAT compartan accidentalmente el cupo.
    const authorization = String(req?.headers?.authorization || '');
    const apiKeyMatch = /(?:^Bearer\s+)?lm_live_([a-f0-9]{16})_/i.exec(authorization);
    if (apiKeyMatch) return `api:${apiKeyMatch[1].toLowerCase()}`;
    const headerKeyMatch = /^lm_live_([a-f0-9]{16})_/i.exec(String(req?.headers?.['x-api-key'] || ''));
    if (headerKeyMatch) return `api:${headerKeyMatch[1].toLowerCase()}`;

    return `ip:${req.ip}`;
  }
}
